import assert from "node:assert/strict";
import test from "node:test";

import type { CrashRecord } from "../diagnostics/crash-record";
import type {
  EventLogEntry,
  PreviousSessionSnapshot,
} from "../diagnostics/event-log";
import {
  MAX_VISIBLE_PREVIOUS_EVENTS,
  getPreviousExitPanelCopy,
  getRecentPreviousEvents,
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
