import assert from "node:assert/strict";
import test from "node:test";

import type { CrashRecord } from "../diagnostics/crash-record";
import type {
  EventLogEntry,
  PreviousSessionSnapshot,
} from "../diagnostics/event-log";
import type {
  ExitInfo,
  JavaCrashRecord,
} from "../../modules/tenglu-region-sampler/src/TengluRegionSampler.types";
import {
  MAX_JAVA_CRASH_MESSAGE_CODE_POINTS,
  MAX_VISIBLE_PREVIOUS_EVENTS,
  formatExitReasonEventDetail,
  formatExitTraceEventDetail,
  formatJavaCrashEventDetail,
  formatJavaCrashSummary,
  formatSavedExitTrace,
  formatSystemExitReason,
  getJavaCrashStackFrames,
  getPreviousExitPanelCopy,
  getRecentPreviousEvents,
  loadPreviousJavaCrash,
  loadPreviousExitInfo,
  savePreviousExitTrace,
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
    has_trace: true,
    ...overrides,
  };
}

function javaCrash(overrides: Partial<JavaCrashRecord> = {}): JavaCrashRecord {
  return {
    path: "/data/user/0/example/files/diagnostics/java-crashes/1788314405000.txt",
    timestamp: Date.parse("2026-09-02T02:00:05.000Z"),
    head: [
      "timestamp=1788314405000",
      'app_version="3.1.6"',
      'thread="mqt_native_modules"',
      "exception_class=java.lang.IllegalStateException",
      'message="界面切换失败"',
      "stack_trace:",
      "java.lang.IllegalStateException: 界面切换失败",
      "\tat com.example.FakeScreen.render(FakeScreen.kt:42)",
      "\tat com.example.FakeRouter.push(FakeRouter.kt:18)",
      "\tat com.example.FakeApp.start(FakeApp.kt:7)",
      "\tat com.example.FakeMain.main(FakeMain.kt:3)",
    ].join("\n"),
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
  assert.equal(
    shouldShowPreviousExit(null, previousSession(false), javaCrash()),
    true,
  );
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
    "reason_name=REASON_LOW_MEMORY status=0 pss_kb=123456 has_trace=true description=low memory",
  );
  assert.equal(
    formatExitReasonEventDetail(exitInfo({ description: "字".repeat(81) })),
    `reason_name=REASON_CRASH_NATIVE status=0 pss_kb=123456 has_trace=true description=${"字".repeat(80)}`,
  );
});

test("matching native exit saves its trace, logs counts, and supplies panel copy", async () => {
  const info = exitInfo();
  const sample = {
    bin_path: "/data/user/0/example/files/diagnostics/exit-traces/1.bin",
    strings_path: "/data/user/0/example/files/diagnostics/exit-traces/1.strings.txt",
    byte_count: 12_345,
    string_count: 67,
  };
  const logged: string[] = [];

  const result = await savePreviousExitTrace(
    { async saveLastExitTrace() {
      return sample;
    } },
    info,
    (saved) => logged.push(formatExitTraceEventDetail(saved)),
  );

  assert.deepEqual(result, sample);
  assert.deepEqual(logged, ["byte_count=12345 string_count=67"]);
  assert.equal(formatSavedExitTrace(result), "已保存崩溃现场 12345 字节");
});

test("missing native trace logs the empty result and supplies no-trace panel copy", async () => {
  const logged: string[] = [];
  const result = await savePreviousExitTrace(
    { async saveLastExitTrace() {
      return null;
    } },
    exitInfo({ has_trace: false }),
    (saved) => logged.push(formatExitTraceEventDetail(saved)),
  );

  assert.equal(result, null);
  assert.deepEqual(logged, ["saved=false"]);
  assert.equal(formatSavedExitTrace(result), "无崩溃现场");
});

test("missing saveLastExitTrace native function is tolerated during startup", async () => {
  let callbackResult: unknown = "not-called";

  const result = await savePreviousExitTrace(
    {},
    exitInfo(),
    (saved) => {
      callbackResult = saved;
    },
  );

  assert.equal(result, null);
  assert.equal(callbackResult, null);
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

test("new Java crash records log the bounded message and supply panel details", async () => {
  const session = previousSession(false);
  session.appStartedAt = "2026-09-02T02:00:00.000Z";
  const longMessage = `${"字".repeat(MAX_JAVA_CRASH_MESSAGE_CODE_POINTS)}🙂尾`;
  const sample = javaCrash({
    head: javaCrash().head.replace(
      'message="界面切换失败"',
      `message=${JSON.stringify(longMessage)}`,
    ),
  });
  const logged: string[] = [];

  const result = await loadPreviousJavaCrash(
    { async readLatestJavaCrash() {
      return sample;
    } },
    session,
    (record) => logged.push(formatJavaCrashEventDetail(record)),
  );

  assert.deepEqual(result, sample);
  assert.deepEqual(logged, [
    `java.lang.IllegalStateException · ${"字".repeat(MAX_JAVA_CRASH_MESSAGE_CODE_POINTS)} · at com.example.FakeScreen.render(FakeScreen.kt:42)`,
  ]);
  assert.equal(logged[0]?.includes("🙂尾"), false);
  assert.equal(
    formatJavaCrashSummary(result),
    `Java 异常：java.lang.IllegalStateException：${longMessage}`,
  );
  assert.deepEqual(getJavaCrashStackFrames(result), [
    "at com.example.FakeScreen.render(FakeScreen.kt:42)",
    "at com.example.FakeRouter.push(FakeRouter.kt:18)",
    "at com.example.FakeApp.start(FakeApp.kt:7)",
  ]);
});

test("missing, absent, and stale Java crash records all degrade to no record", async () => {
  const session = previousSession(false);
  session.appStartedAt = "2026-09-02T02:00:00.000Z";
  let matches = 0;
  const onMatch = () => {
    matches += 1;
  };

  assert.equal(await loadPreviousJavaCrash(
    { async readLatestJavaCrash() {
      return null;
    } },
    session,
    onMatch,
  ), null);
  assert.equal(await loadPreviousJavaCrash({}, session, onMatch), null);
  assert.equal(await loadPreviousJavaCrash(
    { async readLatestJavaCrash() {
      return javaCrash({ timestamp: Date.parse(session.appStartedAt ?? "") });
    } },
    session,
    onMatch,
  ), null);
  assert.equal(matches, 0);
});

test("Java crash reader failures are swallowed during startup", async () => {
  let matched = false;
  const result = await loadPreviousJavaCrash(
    { async readLatestJavaCrash() {
      throw new Error("native read failed");
    } },
    previousSession(true),
    () => {
      matched = true;
    },
  );

  assert.equal(result, null);
  assert.equal(matched, false);
});
