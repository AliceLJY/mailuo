import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from 'zod';

import {
  MODEL_REQUEST_TIMEOUT_MS,
  OpenAICompatibleProvider,
  ProviderRequestError,
  StructuredOutputError,
  createTextProvider,
} from '../../../shared/core/llm/provider.ts';

class MockProvider extends OpenAICompatibleProvider {
  readonly requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  private readonly responses: string[];

  constructor(responses: string[]) {
    super({
      name: 'MockProvider',
      model: 'mock-model',
      apiKeyEnv: 'MOCK_API_KEY',
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      fetchImpl: async () => {
        throw new Error('fetch should not be called in MockProvider');
      },
    });
    this.responses = [...responses];
  }

  override async complete(request: { messages: Array<{ role: string; content: unknown }> }): Promise<string> {
    this.requests.push({ messages: request.messages });
    const next = this.responses.shift();

    if (!next) {
      throw new Error('No mock response available');
    }

    return next;
  }
}

function createNeverReturningProvider(onSignal: (signal: AbortSignal) => void) {
  return new (class extends OpenAICompatibleProvider {
    constructor() {
      super({
        name: 'MockProvider',
        model: 'mock-model',
        apiKeyEnv: 'MOCK_API_KEY',
        apiKey: 'test-key',
        baseUrl: 'https://example.test',
        fetchImpl: ((_input, init) => {
          onSignal(init?.signal as AbortSignal);
          return new Promise<Response>(() => {});
        }) as typeof fetch,
      });
    }
  })();
}

function assertTimeoutError(error: unknown, seconds: number): boolean {
  assert.ok(error instanceof ProviderRequestError);
  assert.equal(error.code, 'PROVIDER_REQUEST_TIMEOUT');
  assert.equal(error.message, `模型请求超时（${seconds} 秒），请检查网络后重试`);
  return true;
}

test('generateStructuredOutput retries once with validation details', async () => {
  const provider = new MockProvider([
    JSON.stringify({ score: 'wrong' }),
    JSON.stringify({ score: 7 }),
  ]);

  const result = await provider.generateStructuredOutput({
    schema: z.object({ score: z.number() }),
    messages: [{ role: 'user', content: 'Return score JSON.' }],
  });

  assert.equal(result.score, 7);
  assert.equal(provider.requests.length, 2);
  const retryMessages = provider.requests[1]?.messages ?? [];
  const retryPrompt = retryMessages[retryMessages.length - 1];
  assert.equal(retryPrompt?.role, 'user');
  assert.match(String(retryPrompt?.content), /Schema validation failed/);
  assert.match(String(retryPrompt?.content), /score: Invalid input: expected number, received string/);
});

test('generateStructuredOutput throws explicit error after two invalid attempts', async () => {
  const provider = new MockProvider(['not json', 'still not json']);

  await assert.rejects(
    provider.generateStructuredOutput({
      schema: z.object({ ok: z.boolean() }),
      messages: [{ role: 'user', content: 'Return ok JSON.' }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof StructuredOutputError);
      assert.match(error.message, /invalid structured output after 2 attempts/);
      assert.match(error.message, /JSON parse failed/);
      assert.equal(error.rawText, 'still not json');
      return true;
    },
  );
});

test('text request aborts and rejects after 60 seconds when fetch never returns', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const provider = createNeverReturningProvider((nextSignal) => {
    signal = nextSignal;
  });

  const result = provider.complete({
    messages: [{ role: 'user', content: 'Return JSON.' }],
  });

  context.mock.timers.tick(MODEL_REQUEST_TIMEOUT_MS.text);

  await assert.rejects(result, (error) => assertTimeoutError(error, 60));
  assert.equal(signal?.aborted, true);
});

test('vision request uses the 90 second timeout', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const provider = createNeverReturningProvider((nextSignal) => {
    signal = nextSignal;
  });

  const result = provider.complete({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Inspect this image.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,ZmFrZQ==' } },
      ],
    }],
  });

  context.mock.timers.tick(MODEL_REQUEST_TIMEOUT_MS.vision - 1);
  assert.equal(signal?.aborted, false);
  context.mock.timers.tick(1);

  await assert.rejects(result, (error) => assertTimeoutError(error, 90));
  assert.equal(signal?.aborted, true);
});

test('request timeout also covers a response body that never finishes', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const provider = new (class extends OpenAICompatibleProvider {
    constructor() {
      super({
        name: 'MockProvider',
        model: 'mock-model',
        apiKeyEnv: 'MOCK_API_KEY',
        apiKey: 'test-key',
        baseUrl: 'https://example.test',
        fetchImpl: ((_input, init) => {
          signal = init?.signal as AbortSignal;
          return Promise.resolve({
            status: 200,
            json: () => new Promise<never>(() => {}),
          } as unknown as Response);
        }) as typeof fetch,
      });
    }
  })();

  const result = provider.complete({
    messages: [{ role: 'user', content: 'Return JSON.' }],
  });
  await Promise.resolve();
  context.mock.timers.tick(MODEL_REQUEST_TIMEOUT_MS.text);

  await assert.rejects(result, (error) => assertTimeoutError(error, 60));
  assert.equal(signal?.aborted, true);
});

test('text provider uses Qwen qwen-plus when DeepSeek is not configured', () => {
  const provider = createTextProvider({ dashscopeApiKey: 'dashscope-test-key' });

  assert.equal(provider.name, 'Qwen');
  assert.equal(provider.model, 'qwen-plus');
  assert.equal(provider.apiKeyEnv, 'DASHSCOPE_API_KEY');
  assert.equal(provider.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
});

test('text provider keeps using DeepSeek when its key is configured', () => {
  const provider = createTextProvider({
    dashscopeApiKey: 'dashscope-test-key',
    deepseekApiKey: 'deepseek-test-key',
  });

  assert.equal(provider.name, 'DeepSeek');
  assert.equal(provider.model, 'deepseek-v4-flash');
  assert.equal(provider.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(provider.baseUrl, 'https://api.deepseek.com');
});
