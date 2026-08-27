import assert from "node:assert/strict";
import test from "node:test";

import type { LocalLlmSecretName, LocalLlmSecretStore } from "../connection/secrets";
import { createLocalProviderFactory } from "../local/providers";

function createFakeKeys(
  values: Partial<Record<LocalLlmSecretName, string>>,
): LocalLlmSecretStore {
  return {
    async get(name) {
      return values[name] ?? null;
    },
    async set() {},
    async clear() {},
    async clearAll() {},
  };
}

test("local text provider falls back to qwen-plus without a DeepSeek key", async () => {
  const provider = await createLocalProviderFactory().createTextProvider(
    createFakeKeys({ DASHSCOPE_API_KEY: "dashscope-test-key" }),
  );

  assert.equal(provider.name, "Qwen");
  assert.equal(provider.model, "qwen-plus");
});

test("local text provider keeps the configured DeepSeek channel", async () => {
  const provider = await createLocalProviderFactory().createTextProvider(
    createFakeKeys({
      DASHSCOPE_API_KEY: "dashscope-test-key",
      DEEPSEEK_API_KEY: "deepseek-test-key",
      DEEPSEEK_MODEL: "deepseek-custom",
    }),
  );

  assert.equal(provider.name, "DeepSeek");
  assert.equal(provider.model, "deepseek-custom");
});
