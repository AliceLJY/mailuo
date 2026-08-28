import assert from "node:assert/strict";
import test from "node:test";

import {
  createConnectionConfigStore,
  getLocalProcessingSettings,
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
  });
});

test("cloud override and OCR export preference survive storage round trip", async () => {
  const memory = createMemoryStorage();
  const store = createConnectionConfigStore(memory.storage);

  await store.set({
    mode: "local",
    perceptionPath: "cloud",
    exportOcrResults: true,
  });

  assert.deepEqual(await store.get(), {
    mode: "local",
    perceptionPath: "cloud",
    exportOcrResults: true,
  });
  assert.deepEqual(JSON.parse(memory.read() ?? "null"), {
    mode: "local",
    perceptionPath: "cloud",
    exportOcrResults: true,
  });
});

test("invalid optional processing fields fall back without rejecting a valid connection", async () => {
  const memory = createMemoryStorage(JSON.stringify({
    mode: "local",
    perceptionPath: "desktop-vision",
    exportOcrResults: "yes",
  }));
  const stored = await createConnectionConfigStore(memory.storage).get();

  assert.deepEqual(stored, { mode: "local" });
  assert.deepEqual(getLocalProcessingSettings(stored), {
    perceptionPath: "ocr",
    exportOcrResults: false,
  });
});
