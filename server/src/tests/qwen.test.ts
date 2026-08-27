import test from 'node:test';
import assert from 'node:assert/strict';

import { QwenProvider } from '../llm/qwen.ts';

const QWEN_ENV_KEYS = [
  'QWEN_MODEL',
  'QWEN_VISION_MODEL',
  'DASHSCOPE_BASE_URL',
  'DASHSCOPE_API_KEY',
] as const;

type QwenEnvPatch = Partial<Record<(typeof QWEN_ENV_KEYS)[number], string | undefined>>;

async function withQwenEnv(
  patch: QwenEnvPatch,
  run: () => void | Promise<void>,
): Promise<void> {
  const previous = new Map<(typeof QWEN_ENV_KEYS)[number], string | undefined>();

  for (const envName of QWEN_ENV_KEYS) {
    previous.set(envName, process.env[envName]);
  }

  try {
    for (const envName of QWEN_ENV_KEYS) {
      const nextValue = patch[envName];

      if (nextValue === undefined) {
        delete process.env[envName];
        continue;
      }

      process.env[envName] = nextValue;
    }

    await run();
  } finally {
    for (const envName of QWEN_ENV_KEYS) {
      const originalValue = previous.get(envName);

      if (originalValue === undefined) {
        delete process.env[envName];
        continue;
      }

      process.env[envName] = originalValue;
    }
  }
}

test('QwenProvider falls back to qwen-vl-max and the official base URL when env is unset', async () => {
  await withQwenEnv(
    {
      QWEN_MODEL: undefined,
      QWEN_VISION_MODEL: undefined,
      DASHSCOPE_BASE_URL: undefined,
      DASHSCOPE_API_KEY: undefined,
    },
    () => {
      const provider = new QwenProvider({ apiKey: 'test-key' });

      assert.equal(provider.model, 'qwen-vl-max');
      assert.equal(provider.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    },
  );
});

test('QwenProvider ignores blank model env values and trims the legacy fallback', async () => {
  await withQwenEnv(
    {
      QWEN_MODEL: '   ',
      QWEN_VISION_MODEL: '  legacy-model  ',
      DASHSCOPE_BASE_URL: undefined,
      DASHSCOPE_API_KEY: undefined,
    },
    () => {
      const provider = new QwenProvider({ apiKey: 'test-key' });

      assert.equal(provider.model, 'legacy-model');
    },
  );
});

test('QwenProvider prefers QWEN_MODEL over the legacy QWEN_VISION_MODEL env key', async () => {
  await withQwenEnv(
    {
      QWEN_MODEL: '  preferred-model  ',
      QWEN_VISION_MODEL: 'legacy-model',
      DASHSCOPE_BASE_URL: 'https://env.example.test/',
      DASHSCOPE_API_KEY: 'env-key',
    },
    () => {
      const provider = new QwenProvider();

      assert.equal(provider.model, 'preferred-model');
      assert.equal(provider.baseUrl, 'https://env.example.test');
      assert.equal(provider.apiKey, 'env-key');
    },
  );
});

test('QwenProvider falls back to QWEN_VISION_MODEL when QWEN_MODEL is unset or blank', async () => {
  await withQwenEnv(
    {
      QWEN_MODEL: '   ',
      QWEN_VISION_MODEL: ' legacy-model ',
      DASHSCOPE_BASE_URL: undefined,
      DASHSCOPE_API_KEY: undefined,
    },
    () => {
      const provider = new QwenProvider({ apiKey: 'test-key' });

      assert.equal(provider.model, 'legacy-model');
    },
  );
});

test('QwenProvider lets explicit options override env values', async () => {
  await withQwenEnv(
    {
      QWEN_MODEL: 'env-model',
      QWEN_VISION_MODEL: 'legacy-model',
      DASHSCOPE_BASE_URL: 'https://env.example.test/',
      DASHSCOPE_API_KEY: 'env-key',
    },
    () => {
      const provider = new QwenProvider({
        apiKey: 'test-key',
        model: '  custom-model  ',
        baseUrl: 'https://example.test/',
      });

      assert.equal(provider.model, 'custom-model');
      assert.equal(provider.baseUrl, 'https://example.test');
      assert.equal(provider.apiKey, 'test-key');
    },
  );
});

test('QwenProvider ignores a blank explicit model and falls back to env then default', async () => {
  await withQwenEnv(
    {
      QWEN_MODEL: '  env-model  ',
      QWEN_VISION_MODEL: ' legacy-model ',
      DASHSCOPE_BASE_URL: undefined,
      DASHSCOPE_API_KEY: undefined,
    },
    () => {
      const provider = new QwenProvider({
        apiKey: 'test-key',
        model: '   ',
      });

      assert.equal(provider.model, 'env-model');
    },
  );

  await withQwenEnv(
    {
      QWEN_MODEL: '   ',
      QWEN_VISION_MODEL: '   ',
      DASHSCOPE_BASE_URL: undefined,
      DASHSCOPE_API_KEY: undefined,
    },
    () => {
      const provider = new QwenProvider({
        apiKey: 'test-key',
        model: '   ',
      });

      assert.equal(provider.model, 'qwen-vl-max');
    },
  );
});
