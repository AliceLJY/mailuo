import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from 'zod';

import { OpenAICompatibleProvider, StructuredOutputError } from '../../../shared/core/llm/provider.ts';

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
