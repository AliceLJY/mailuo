import assert from "node:assert/strict";
import test from "node:test";

import {
  CRASH_RECORD_KEY,
  clearCrashRecord,
  createCrashRecord,
  installGlobalCrashHandler,
  readCrashRecord,
  setCrashContext,
  writeCrashRecord,
  type SyncCrashStorage,
} from "../diagnostics/crash-record";

function createMemoryStorage(initial: string | null = null) {
  let value = initial;
  const calls: string[] = [];
  const storage: SyncCrashStorage = {
    getItemSync(key) {
      calls.push(`get:${key}`);
      return value;
    },
    setItemSync(key, nextValue) {
      calls.push(`set:${key}`);
      value = nextValue;
    },
    removeItemSync(key) {
      calls.push(`remove:${key}`);
      const existed = value !== null;
      value = null;
      return existed;
    },
  };

  return { calls, read: () => value, storage };
}

test("crash record keeps context, numeric Hermes stats, and only the first eight frames", () => {
  const error = new TypeError("boom");
  error.stack = [
    "TypeError: boom",
    ...Array.from({ length: 10 }, (_, index) => `at frame${index + 1} (app.ts:${index + 1}:1)`),
  ].join("\n");

  const record = createCrashRecord(error, true, {
    context: {
      appVersion: "3.1.2",
      currentRoute: "/review/42",
      batchProgress: { position: 2, totalCount: 5, status: "processing" },
      exportOcrResults: true,
    },
    hermesStats: {
      finite: 12,
      infinite: Number.POSITIVE_INFINITY,
      label: "ignored",
    },
    now: () => new Date("2026-09-02T08:09:10.000Z"),
  });

  assert.deepEqual(record, {
    timestamp: "2026-09-02T08:09:10.000Z",
    name: "TypeError",
    message: "boom",
    stackFrames: Array.from(
      { length: 8 },
      (_, index) => `at frame${index + 1} (app.ts:${index + 1}:1)`,
    ),
    isFatal: true,
    appVersion: "3.1.2",
    currentRoute: "/review/42",
    batchProgress: { position: 2, totalCount: 5, status: "processing" },
    exportOcrResults: true,
    hermesStats: { finite: 12 },
  });
});

test("sync storage round trip and acknowledgement use the dedicated crash key", () => {
  const memory = createMemoryStorage();
  const written = writeCrashRecord(memory.storage, "plain failure", false, {
    context: { appVersion: "3.1.2", currentRoute: "/settings" },
    hermesStats: null,
    now: () => new Date("2026-09-02T08:09:10.000Z"),
  });

  assert.equal(JSON.parse(memory.read() ?? "null").message, "plain failure");
  assert.deepEqual(readCrashRecord(memory.storage), written);
  assert.equal(clearCrashRecord(memory.storage), true);
  assert.equal(readCrashRecord(memory.storage), null);
  assert.deepEqual(memory.calls, [
    `set:${CRASH_RECORD_KEY}`,
    `get:${CRASH_RECORD_KEY}`,
    `remove:${CRASH_RECORD_KEY}`,
    `get:${CRASH_RECORD_KEY}`,
  ]);

  const malformed = createMemoryStorage('{"message":"incomplete"}');
  assert.equal(readCrashRecord(malformed.storage), null);
});

test("global handler always delegates the original error even when crash storage fails", () => {
  const storage: SyncCrashStorage = {
    getItemSync() {
      return null;
    },
    setItemSync() {
      throw new Error("disk unavailable");
    },
    removeItemSync() {
      return false;
    },
  };
  const originalFailure = new Error("original handler");
  const sourceError = new Error("source failure");
  let delegated: [unknown, boolean | undefined] | null = null;
  const originalHandler = (error: unknown, isFatal?: boolean) => {
    delegated = [error, isFatal];
    throw originalFailure;
  };
  let currentHandler = originalHandler;
  const errorUtils = {
    getGlobalHandler: () => currentHandler,
    setGlobalHandler(handler: typeof currentHandler) {
      currentHandler = handler;
    },
  };
  const uninstall = installGlobalCrashHandler(storage, errorUtils);

  assert.throws(() => currentHandler(sourceError, true), originalFailure);
  assert.deepEqual(delegated, [sourceError, true]);

  uninstall();
  assert.equal(currentHandler, originalHandler);
});

test("global handler synchronously records fatal context before delegating", () => {
  const events: string[] = [];
  let serialized: string | null = null;
  const storage: SyncCrashStorage = {
    getItemSync() {
      return serialized;
    },
    setItemSync(_key, value) {
      events.push("stored");
      serialized = value;
    },
    removeItemSync() {
      serialized = null;
      return true;
    },
  };
  const originalHandler = (_error: unknown, _isFatal?: boolean) => {
    events.push("delegated");
  };
  let currentHandler = originalHandler;
  const errorUtils = {
    getGlobalHandler: () => currentHandler,
    setGlobalHandler(handler: typeof currentHandler) {
      currentHandler = handler;
    },
  };
  setCrashContext({
    appVersion: "3.1.2",
    currentRoute: "/review/88",
    batchProgress: { position: 3, totalCount: 4, status: "processing" },
    exportOcrResults: true,
  });
  const uninstall = installGlobalCrashHandler(storage, errorUtils);

  currentHandler(new RangeError("fatal test"), true);

  assert.deepEqual(events, ["stored", "delegated"]);
  const record = readCrashRecord(storage);
  assert.equal(record?.name, "RangeError");
  assert.equal(record?.message, "fatal test");
  assert.equal(record?.isFatal, true);
  assert.equal(record?.currentRoute, "/review/88");
  assert.deepEqual(record?.batchProgress, {
    position: 3,
    totalCount: 4,
    status: "processing",
  });

  uninstall();
});
