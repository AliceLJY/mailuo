import test from 'node:test';
import assert from 'node:assert/strict';

import { DeepSeekProvider } from '../llm/deepseek.ts';

const DEEPSEEK_ENV_KEYS = [
  'DEEPSEEK_MODEL',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_API_KEY',
] as const;

type DeepSeekEnvPatch = Partial<Record<(typeof DEEPSEEK_ENV_KEYS)[number], string | undefined>>;

async function withDeepSeekEnv(
  patch: DeepSeekEnvPatch,
  run: () => void | Promise<void>,
): Promise<void> {
  const previous = new Map<(typeof DEEPSEEK_ENV_KEYS)[number], string | undefined>();

  for (const envName of DEEPSEEK_ENV_KEYS) {
    previous.set(envName, process.env[envName]);
  }

  try {
    for (const envName of DEEPSEEK_ENV_KEYS) {
      const nextValue = patch[envName];

      if (nextValue === undefined) {
        delete process.env[envName];
        continue;
      }

      process.env[envName] = nextValue;
    }

    await run();
  } finally {
    for (const envName of DEEPSEEK_ENV_KEYS) {
      const originalValue = previous.get(envName);

      if (originalValue === undefined) {
        delete process.env[envName];
        continue;
      }

      process.env[envName] = originalValue;
    }
  }
}

test('DeepSeekProvider falls back to deepseek-v4-flash and the official base URL when env is unset', async () => {
  await withDeepSeekEnv(
    {
      DEEPSEEK_MODEL: undefined,
      DEEPSEEK_BASE_URL: undefined,
      DEEPSEEK_API_KEY: undefined,
    },
    () => {
      const provider = new DeepSeekProvider({ apiKey: 'test-key' });

      assert.equal(provider.model, 'deepseek-v4-flash');
      assert.equal(provider.baseUrl, 'https://api.deepseek.com');
    },
  );
});

test('DeepSeekProvider ignores blank env models and falls back to the default', async () => {
  await withDeepSeekEnv(
    {
      DEEPSEEK_MODEL: '   ',
      DEEPSEEK_BASE_URL: undefined,
      DEEPSEEK_API_KEY: undefined,
    },
    () => {
      const provider = new DeepSeekProvider({ apiKey: 'test-key' });

      assert.equal(provider.model, 'deepseek-v4-flash');
    },
  );
});

test('DeepSeekProvider reads model, base URL, and API key from env when options do not override them', async () => {
  await withDeepSeekEnv(
    {
      DEEPSEEK_MODEL: '  env-model  ',
      DEEPSEEK_BASE_URL: 'https://env.example.test/',
      DEEPSEEK_API_KEY: 'env-key',
    },
    () => {
      const provider = new DeepSeekProvider();

      assert.equal(provider.model, 'env-model');
      assert.equal(provider.baseUrl, 'https://env.example.test');
      assert.equal(provider.apiKey, 'env-key');
    },
  );
});

test('DeepSeekProvider lets explicit options override env values', async () => {
  await withDeepSeekEnv(
    {
      DEEPSEEK_MODEL: 'env-model',
      DEEPSEEK_BASE_URL: 'https://env.example.test/',
      DEEPSEEK_API_KEY: 'env-key',
    },
    () => {
      const provider = new DeepSeekProvider({
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

test('DeepSeekProvider ignores a blank explicit model and falls back to trimmed env values', async () => {
  await withDeepSeekEnv(
    {
      DEEPSEEK_MODEL: '  env-model  ',
      DEEPSEEK_BASE_URL: undefined,
      DEEPSEEK_API_KEY: undefined,
    },
    () => {
      const provider = new DeepSeekProvider({
        apiKey: 'test-key',
        model: '   ',
      });

      assert.equal(provider.model, 'env-model');
    },
  );
});
