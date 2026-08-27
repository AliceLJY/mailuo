import assert from 'node:assert/strict';
import test from 'node:test';

import { createTextProvider } from '../llm/text.ts';

const TEXT_ENV_KEYS = [
  'DASHSCOPE_API_KEY',
  'DEEPSEEK_API_KEY',
  'QWEN_TEXT_MODEL',
  'DEEPSEEK_MODEL',
  'DASHSCOPE_BASE_URL',
  'DEEPSEEK_BASE_URL',
] as const;

type TextEnvPatch = Partial<Record<(typeof TEXT_ENV_KEYS)[number], string | undefined>>;

async function withTextEnv(patch: TextEnvPatch, run: () => void | Promise<void>): Promise<void> {
  const previous = new Map<(typeof TEXT_ENV_KEYS)[number], string | undefined>();

  for (const envName of TEXT_ENV_KEYS) {
    previous.set(envName, process.env[envName]);
  }

  try {
    for (const envName of TEXT_ENV_KEYS) {
      const nextValue = patch[envName];

      if (nextValue === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = nextValue;
      }
    }

    await run();
  } finally {
    for (const envName of TEXT_ENV_KEYS) {
      const previousValue = previous.get(envName);

      if (previousValue === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previousValue;
      }
    }
  }
}

test('server text provider accepts a missing DeepSeek key and uses the Qwen text override', async () => {
  await withTextEnv(
    {
      DASHSCOPE_API_KEY: 'dashscope-test-key',
      DEEPSEEK_API_KEY: undefined,
      QWEN_TEXT_MODEL: '  qwen-custom  ',
      DEEPSEEK_MODEL: undefined,
      DASHSCOPE_BASE_URL: undefined,
      DEEPSEEK_BASE_URL: undefined,
    },
    () => {
      const provider = createTextProvider();

      assert.equal(provider.name, 'Qwen');
      assert.equal(provider.model, 'qwen-custom');
    },
  );
});

test('server text provider still prefers DeepSeek when its key is configured', async () => {
  await withTextEnv(
    {
      DASHSCOPE_API_KEY: 'dashscope-test-key',
      DEEPSEEK_API_KEY: 'deepseek-test-key',
      QWEN_TEXT_MODEL: 'qwen-custom',
      DEEPSEEK_MODEL: '  deepseek-custom  ',
      DASHSCOPE_BASE_URL: undefined,
      DEEPSEEK_BASE_URL: undefined,
    },
    () => {
      const provider = createTextProvider();

      assert.equal(provider.name, 'DeepSeek');
      assert.equal(provider.model, 'deepseek-custom');
    },
  );
});
