import assert from "node:assert/strict";
import test from "node:test";

import {
  createConnectionConfigStore,
  getLocalProcessingSettings,
  parseSelfNamesInput,
  type TextStorage,
} from "../connection/config";

function createMemoryStorage(initial: string | null = null) {
  let value = initial;
  const storage: TextStorage = {
    async getItem() {
      return value;
    },
    async setItem(_key, nextValue) {
      value = nextValue;
    },
    async removeItem() {
      value = null;
    },
  };

  return { storage, read: () => value };
}

test("legacy local config defaults to on-device OCR with export disabled", async () => {
  const memory = createMemoryStorage(JSON.stringify({ mode: "local" }));
  const stored = await createConnectionConfigStore(memory.storage).get();

  assert.deepEqual(stored, { mode: "local" });
  assert.deepEqual(getLocalProcessingSettings(stored), {
    perceptionPath: "ocr",
    exportOcrResults: false,
    selfNames: [],
  });
});

test("cloud override, OCR export preference, and self names survive storage round trip", async () => {
  const memory = createMemoryStorage();
  const store = createConnectionConfigStore(memory.storage);

  await store.set({
    mode: "local",
    perceptionPath: "cloud",
    exportOcrResults: true,
    selfNames: ["  小禾 ", "麦  老师", "小禾"],
  });

  assert.deepEqual(await store.get(), {
    mode: "local",
    perceptionPath: "cloud",
    exportOcrResults: true,
    selfNames: ["小禾", "麦 老师"],
  });
  assert.deepEqual(JSON.parse(memory.read() ?? "null"), {
    mode: "local",
    perceptionPath: "cloud",
    exportOcrResults: true,
    selfNames: ["小禾", "麦 老师"],
  });
});

test("self-name input accepts Chinese and ASCII commas and removes normalized duplicates", () => {
  assert.deepEqual(
    parseSelfNamesInput(" 小禾,麦  老师，XIAOHE，xiaohe，，"),
    ["小禾", "麦 老师", "XIAOHE"],
  );
});

test("invalid optional processing fields fall back without rejecting a valid connection", async () => {
  const memory = createMemoryStorage(JSON.stringify({
    mode: "local",
    perceptionPath: "desktop-vision",
    exportOcrResults: "yes",
    selfNames: [" ", 7, "小禾", " 小禾 "],
  }));
  const stored = await createConnectionConfigStore(memory.storage).get();

  assert.deepEqual(stored, { mode: "local", selfNames: ["小禾"] });
  assert.deepEqual(getLocalProcessingSettings(stored), {
    perceptionPath: "ocr",
    exportOcrResults: false,
    selfNames: ["小禾"],
  });
});

test("server mode has an empty self-name placeholder without changing server routing", () => {
  assert.deepEqual(
    getLocalProcessingSettings({ mode: "server", serverUrl: "https://mailuo.test" }),
    { perceptionPath: "ocr", exportOcrResults: false, selfNames: [] },
  );
});
