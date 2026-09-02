import assert from "node:assert/strict";
import test from "node:test";

import type { CrashRecord } from "../diagnostics/crash-record";
import type {
  EventLogEntry,
  PreviousSessionSnapshot,
} from "../diagnostics/event-log";
import type { ExitInfo } from "../../modules/tenglu-region-sampler/src/TengluRegionSampler.types";
import {
  MAX_VISIBLE_PREVIOUS_EVENTS,
  formatExitReasonEventDetail,
  formatSystemExitReason,
  getPreviousExitPanelCopy,
  getRecentPreviousEvents,
  loadPreviousExitInfo,
  shouldShowPreviousExit,
} from "../diagnostics/previous-exit";

function previousSession(
  possiblyAbnormalExit: boolean,
  count = 2,
): PreviousSessionSnapshot {
  const events: EventLogEntry[] = Array.from({ length: count }, (_, index) => ({
    t: new Date(index).toISOString(),
    kind: index === 0 ? "app_start" : "route",
    detail: `/${index}`,
  }));
  const lastEvent = events.at(-1);
  assert.ok(lastEvent);

  return {
    events,
    appStartedAt: events[0]?.t ?? null,
    lastEvent,
    possiblyAbnormalExit,
  };
}

function exitInfo(overrides: Partial<ExitInfo> = {}): ExitInfo {
  return {
    reason: 5,
    reason_name: "REASON_CRASH_NATIVE",
    status: 0,
    description: "native crash",
    timestamp: Date.parse("2026-09-02T02:00:05.000Z"),
    importance: 100,
    pss_kb: 123_456,
    rss_kb: 234_567,
    ...overrides,
  };
}

test("previous-exit panel copy distinguishes a captured crash from event-log-only evidence", () => {
  const withCrash = getPreviousExitPanelCopy(true);
  assert.equal(withCrash.heading, "上次异常退出");
  assert.match(withCrash.intro, /崩溃记录/u);

  const logOnly = getPreviousExitPanelCopy(false);
  assert.equal(logOnly.heading, "上次可能异常退出");
  assert.match(logOnly.intro, /未捕获到崩溃记录/u);
  assert.notDeepEqual(logOnly, withCrash);
});

test("previous-exit visibility accepts either crash data or an abnormal event tail", () => {
  const crashRecord: CrashRecord = {
    timestamp: "2026-09-02T08:09:10.000Z",
    message: "captured",
  };

  assert.equal(shouldShowPreviousExit(null, previousSession(false)), false);
  assert.equal(shouldShowPreviousExit(null, previousSession(true)), true);
  assert.equal(shouldShowPreviousExit(crashRecord, previousSession(false)), true);
});

test("previous-exit panel receives only the last 20 events", () => {
  const recent = getRecentPreviousEvents(
    previousSession(true, MAX_VISIBLE_PREVIOUS_EVENTS + 3),
  );

  assert.equal(recent.length, MAX_VISIBLE_PREVIOUS_EVENTS);
  assert.equal(recent[0]?.detail, "/3");
  assert.equal(recent.at(-1)?.detail, "/22");
});

test("last-exit reader records matching samples and supplies the panel reason", async () => {
  const session = previousSession(true);
  session.appStartedAt = "2026-09-02T02:00:00.000Z";
  const atBoundary = exitInfo({ timestamp: Date.parse(session.appStartedAt) });
  const older = exitInfo({ timestamp: Date.parse("2026-09-02T01:59:59.000Z") });
  const matching = exitInfo({
    description: "low memory",
    reason: 3,
    reason_name: "REASON_LOW_MEMORY",
  });
  const logged: ExitInfo[] = [];

  const result = await loadPreviousExitInfo(
    { async readLastExitInfo() {
      return [older, matching, atBoundary];
    } },
    session,
    (info) => logged.push(info),
  );

  assert.deepEqual(result, matching);
  assert.deepEqual(logged, [matching]);
  assert.equal(
    formatSystemExitReason(result),
    "系统记录的退出原因：REASON_LOW_MEMORY（low memory）",
  );
  assert.equal(
    formatExitReasonEventDetail(result),
    "reason_name=REASON_LOW_MEMORY status=0 pss_kb=123456 description=low memory",
  );
  assert.equal(
    formatExitReasonEventDetail(exitInfo({ description: "字".repeat(81) })),
    `reason_name=REASON_CRASH_NATIVE status=0 pss_kb=123456 description=${"字".repeat(80)}`,
  );
});

test("empty last-exit history reports that the system recorded no reason", async () => {
  const result = await loadPreviousExitInfo(
    { async readLastExitInfo() {
      return [];
    } },
    previousSession(true),
  );

  assert.equal(result, null);
  assert.equal(formatSystemExitReason(result), "系统未记录退出原因");
});

test("last-exit reader failures are swallowed and report no system reason", async () => {
  const result = await loadPreviousExitInfo(
    { async readLastExitInfo() {
      throw new Error("native method unavailable");
    } },
    previousSession(true),
  );

  assert.equal(result, null);
  assert.equal(formatSystemExitReason(result), "系统未记录退出原因");
});
