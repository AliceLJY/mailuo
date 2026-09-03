import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_KINDS,
  EVENT_LOG_KEY,
  MAX_DIAGNOSTIC_EVENT_DETAIL_CODE_POINTS,
  MAX_EVENT_DETAIL_CODE_POINTS,
  MAX_EVENT_LOG_ENTRIES,
  MAX_JAVA_CRASH_EVENT_DETAIL_CODE_POINTS,
  acknowledgePreviousSession,
  appendEvent,
  capturePreviousSession,
  configureEventLogStorage,
  logEvent,
  readEventLog,
  startAppSession,
  type EventLogEntry,
  type SyncEventLogStorage,
} from "../diagnostics/event-log";
import { formatMemoryEventDetail } from "../diagnostics/memory-stats";

function createMemoryStorage(initialEntries: EventLogEntry[] = []) {
  const values = new Map<string, string>();
  if (initialEntries.length > 0) {
    values.set(EVENT_LOG_KEY, JSON.stringify(initialEntries));
  }

  const storage: SyncEventLogStorage = {
    getItemSync(key) {
      return values.get(key) ?? null;
    },
    setItemSync(key, value) {
      values.set(key, value);
    },
  };

  return { storage, values };
}

function event(
  t: string,
  kind: EventLogEntry["kind"],
  detail = "",
): EventLogEntry {
  return { t, kind, detail };
}

test("event log keeps the newest 200 entries and truncates detail by Unicode code point", () => {
  const memory = createMemoryStorage();

  for (let index = 0; index < MAX_EVENT_LOG_ENTRIES + 5; index += 1) {
    appendEvent(memory.storage, "route", `/${index}`, {
      now: () => new Date(index),
    });
  }
  appendEvent(memory.storage, "confirm_error", "🙂".repeat(121), {
    now: () => new Date(1000),
  });

  const entries = readEventLog(memory.storage);
  assert.equal(entries.length, MAX_EVENT_LOG_ENTRIES);
  assert.equal(entries[0]?.detail, "/6");
  assert.equal(entries.at(-1)?.kind, "confirm_error");
  assert.equal(
    Array.from(entries.at(-1)?.detail ?? "").length,
    MAX_EVENT_DETAIL_CODE_POINTS,
  );
  assert.ok(memory.values.has(EVENT_LOG_KEY));
});

test("startAppSession snapshots the previous segment before app_start and uses the literal tail kind", () => {
  const normal = createMemoryStorage([
    event("2026-09-02T00:00:00.000Z", "app_start"),
    event("2026-09-02T00:00:01.000Z", "confirm_error", "failed"),
    event("2026-09-02T00:00:02.000Z", "app_background"),
  ]);
  const normalSnapshot = startAppSession(normal.storage, {
    now: () => new Date("2026-09-02T01:00:00.000Z"),
  });

  assert.equal(normalSnapshot?.possiblyAbnormalExit, false);
  assert.equal(normalSnapshot?.lastEvent.kind, "app_background");
  assert.equal(normalSnapshot?.events.length, 3);
  assert.equal(readEventLog(normal.storage).at(-1)?.kind, "app_start");

  const abnormal = createMemoryStorage([
    event("2026-09-02T02:00:00.000Z", "app_start"),
    event("2026-09-02T02:00:01.000Z", "confirm_error", "failed"),
  ]);
  const abnormalSnapshot = startAppSession(abnormal.storage, {
    now: () => new Date("2026-09-02T03:00:00.000Z"),
  });

  assert.equal(abnormalSnapshot?.possiblyAbnormalExit, true);
  assert.equal(abnormalSnapshot?.lastEvent.kind, "confirm_error");
  assert.deepEqual(
    abnormalSnapshot?.events.map((entry) => entry.kind),
    ["app_start", "confirm_error"],
  );
});

test("async diagnostic tails do not override the last app lifecycle state", () => {
  const backgrounded = createMemoryStorage([
    event("2026-09-02T00:00:00.000Z", "app_start"),
    event("2026-09-02T00:00:01.000Z", "app_background"),
    event("2026-09-02T00:00:02.000Z", "mem", "source=route path=/insights"),
    event("2026-09-02T00:00:03.000Z", "insights_ok", "contacts=33"),
    event("2026-09-02T00:00:04.000Z", "exit_reason", "reason_name=REASON_LOW_MEMORY"),
  ]);
  const activeAgain = createMemoryStorage([
    ...readEventLog(backgrounded.storage),
    event("2026-09-02T00:00:05.000Z", "app_active"),
    event("2026-09-02T00:00:06.000Z", "mem", "source=route path=/insights"),
  ]);

  const backgroundedSnapshot = capturePreviousSession(backgrounded.storage);
  const activeSnapshot = capturePreviousSession(activeAgain.storage);

  assert.equal(backgroundedSnapshot?.lastEvent.kind, "exit_reason");
  assert.equal(backgroundedSnapshot?.possiblyAbnormalExit, false);
  assert.equal(activeSnapshot?.lastEvent.kind, "mem");
  assert.equal(activeSnapshot?.possiblyAbnormalExit, true);
});

test("acknowledgement marker identifies the previous app_start", () => {
  const memory = createMemoryStorage([
    event("2026-09-02T02:00:00.000Z", "app_start"),
    event("2026-09-02T02:00:01.000Z", "confirm_error"),
  ]);
  const snapshot = startAppSession(memory.storage, {
    now: () => new Date("2026-09-02T03:00:00.000Z"),
  });

  acknowledgePreviousSession(memory.storage, snapshot, {
    now: () => new Date("2026-09-02T03:00:01.000Z"),
  });

  assert.deepEqual(readEventLog(memory.storage).at(-1), {
    t: "2026-09-02T03:00:01.000Z",
    kind: "acknowledged",
    detail: "previous_app_start=2026-09-02T02:00:00.000Z",
  });
});

test("configured logEvent is synchronous and storage failures do not escape", () => {
  const stored = createMemoryStorage();
  configureEventLogStorage(stored.storage);
  const entry = logEvent("upload_start", "2");
  assert.equal(entry?.kind, "upload_start");
  assert.equal(readEventLog(stored.storage).length, 1);

  configureEventLogStorage({
    getItemSync() {
      throw new Error("read failed");
    },
    setItemSync() {
      throw new Error("write failed");
    },
  });
  assert.doesNotThrow(() => logEvent("crash", "boom"));
  assert.equal(logEvent("crash", "boom"), null);
  configureEventLogStorage(null);
});

test("diagnostic event kinds survive the event-log read whitelist", () => {
  const memory = createMemoryStorage();
  const javaCrashDetail = [
    "java.lang.IllegalStateException",
    "字".repeat(100),
    `at com.example.${"LongFrame".repeat(12)}.render(FakeScreen.kt:42)`,
  ].join(" · ");
  const kinds = [
    "exit_reason",
    "exit_trace",
    "java_crash",
    "insights_start",
    "insights_ok",
    "insights_error",
    "mem",
  ] as const;

  for (const kind of kinds) {
    assert.ok(EVENT_KINDS.includes(kind));
    appendEvent(
      memory.storage,
      kind,
      kind === "java_crash" ? javaCrashDetail : kind,
    );
  }

  const entries = readEventLog(memory.storage);
  assert.deepEqual(entries.map((entry) => entry.kind), kinds);
  assert.ok(
    Array.from(javaCrashDetail).length > MAX_DIAGNOSTIC_EVENT_DETAIL_CODE_POINTS,
  );
  assert.ok(
    Array.from(javaCrashDetail).length <= MAX_JAVA_CRASH_EVENT_DETAIL_CODE_POINTS,
  );
  assert.equal(
    entries.find((entry) => entry.kind === "java_crash")?.detail,
    javaCrashDetail,
  );
});

test("exit-reason events retain the complete 80-code-point description", () => {
  const memory = createMemoryStorage();
  const description = "字".repeat(80);
  const detail = [
    "reason_name=REASON_EXCESSIVE_RESOURCE_USAGE",
    "status=0",
    "pss_kb=123456",
    `description=${description}`,
  ].join(" ");

  assert.ok(Array.from(detail).length > MAX_EVENT_DETAIL_CODE_POINTS);
  assert.ok(Array.from(detail).length <= MAX_DIAGNOSTIC_EVENT_DETAIL_CODE_POINTS);
  assert.equal(appendEvent(memory.storage, "exit_reason", detail)?.detail, detail);
  assert.equal(readEventLog(memory.storage).at(-1)?.detail, detail);
});

test("memory events retain all Hermes and native fields after persistence", () => {
  const memory = createMemoryStorage();
  const detail = formatMemoryEventDetail(
    "route path=/insights",
    {
      native_heap_kb: 123_456,
      java_heap_kb: 234_567,
      avail_mb: 3_456,
      low_memory: false,
    },
    { js_heap_kb: 345_678, js_allocated_kb: 456_789 },
  );

  assert.ok(Array.from(detail).length > MAX_EVENT_DETAIL_CODE_POINTS);
  appendEvent(memory.storage, "mem", detail);
  assert.equal(readEventLog(memory.storage).at(-1)?.detail, detail);
  assert.match(detail, /avail_mb=3456 low_memory=false$/u);
});

test("every upload progress event appends a paired Hermes memory sample", () => {
  const memory = createMemoryStorage();
  configureEventLogStorage(memory.storage);

  logEvent("upload_progress", "1/2:processing");

  const entries = readEventLog(memory.storage);
  assert.deepEqual(entries.map((entry) => entry.kind), ["upload_progress", "mem"]);
  assert.equal(entries[1]?.detail, "source=upload_progress");
  configureEventLogStorage(null);
});
