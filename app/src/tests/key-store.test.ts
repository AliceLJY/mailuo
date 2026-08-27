import assert from "node:assert/strict";
import test from "node:test";

import { createLocalLlmSecretStore, type SecretStorage } from "../connection/secrets";

class FakeSecretStorage implements SecretStorage {
  readonly values = new Map<string, string>();

  async getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  async deleteItem(key: string) {
    this.values.delete(key);
  }
}

test("secure key wrapper uses only its injected storage and supports get/set/clear", async () => {
  const storage = new FakeSecretStorage();
  const keys = createLocalLlmSecretStore(storage);

  await keys.set("DASHSCOPE_API_KEY", "  dashscope-value  ");
  await keys.set("DEEPSEEK_API_KEY", "deepseek-value");
  await keys.set("QWEN_MODEL", " qwen-test ");
  await keys.set("QWEN_TEXT_MODEL", " qwen-plus-test ");

  assert.equal(await keys.get("DASHSCOPE_API_KEY"), "dashscope-value");
  assert.equal(await keys.get("QWEN_MODEL"), "qwen-test");
  assert.equal(await keys.get("QWEN_TEXT_MODEL"), "qwen-plus-test");

  await keys.clear("DASHSCOPE_API_KEY");
  assert.equal(await keys.get("DASHSCOPE_API_KEY"), null);

  await keys.clearAll();
  assert.equal(storage.values.size, 0);
});

test("secure key wrapper rejects empty values without persisting them", async () => {
  const storage = new FakeSecretStorage();
  const keys = createLocalLlmSecretStore(storage);

  await assert.rejects(() => keys.set("DEEPSEEK_API_KEY", "   "), /不能为空/u);
  assert.equal(storage.values.size, 0);
});
