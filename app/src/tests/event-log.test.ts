import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_LOG_KEY,
  MAX_EVENT_DETAIL_CODE_POINTS,
  MAX_EVENT_LOG_ENTRIES,
  acknowledgePreviousSession,
  appendEvent,
  configureEventLogStorage,
  logEvent,
  readEventLog,
  startAppSession,
  type EventLogEntry,
  type SyncEventLogStorage,
} from "../diagnostics/event-log";

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
