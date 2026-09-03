import { z } from 'zod';

// This module receives provider configuration explicitly and never reads runtime environment state.

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
};

export type ChatCompletionRequest = {
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  responseFormat?: { type: 'json_object' };
};

export type StructuredOutputRequest<T> = {
  schema: z.ZodType<T>;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  responseFormat?: { type: 'json_object' };
};

export interface StructuredOutputProvider {
  readonly name: string;
  readonly model: string;
  complete(request: ChatCompletionRequest): Promise<string>;
  generateStructuredOutput<T>(request: StructuredOutputRequest<T>): Promise<T>;
}

export class ConfigurationError extends Error {
  readonly code: string;
  readonly envName: string;

  constructor(message: string, envName: string, code = 'CONFIG_ERROR') {
    super(message);
    this.name = 'ConfigurationError';
    this.code = code;
    this.envName = envName;
  }
}

export class ProviderRequestError extends Error {
  readonly code: string;
  readonly provider: string;
  readonly model: string;
  readonly statusCode?: number;

  constructor(options: {
    message: string;
    provider: string;
    model: string;
    statusCode?: number;
    code?: string;
  }) {
    super(options.message);
    this.name = 'ProviderRequestError';
    this.code = options.code ?? 'PROVIDER_REQUEST_ERROR';
    this.provider = options.provider;
    this.model = options.model;
    this.statusCode = options.statusCode;
  }
}

export class StructuredOutputError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly rawText: string;
  readonly attempt: number;

  constructor(options: {
    message: string;
    provider: string;
    model: string;
    rawText: string;
    attempt: number;
  }) {
    super(options.message);
    this.name = 'StructuredOutputError';
    this.provider = options.provider;
    this.model = options.model;
    this.rawText = options.rawText;
    this.attempt = options.attempt;
  }
}

export type FetchLike = typeof fetch;

export const MODEL_REQUEST_TIMEOUT_MS = {
  text: 60_000,
  vision: 90_000,
} as const;

export type OpenAICompatibleProviderOptions = {
  name: string;
  model: string;
  apiKeyEnv: string;
  apiKey: string;
  baseUrl: string;
  fetchImpl?: FetchLike;
};

export const DEFAULT_QWEN_TEXT_MODEL = 'qwen-plus';

const DEFAULT_QWEN_TEXT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

export type TextProviderOptions = {
  dashscopeApiKey?: string | null;
  deepseekApiKey?: string | null;
  qwenTextModel?: string | null;
  deepseekModel?: string | null;
  dashscopeBaseUrl?: string;
  deepseekBaseUrl?: string;
  fetchImpl?: FetchLike;
};

type OpenAIChatCompletionResponse = {
  error?: { message?: string; code?: string };
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function extractJsonText(rawText: string): string {
  const trimmed = rawText.trim();

  if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
    const withoutFence = trimmed.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
    return withoutFence.trim();
  }

  return trimmed;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

async function parseStructuredText<T>(
  schema: z.ZodType<T>,
  rawText: string,
): Promise<{ ok: true; value: T } | { ok: false; errorDetail: string }> {
  const jsonText = extractJsonText(rawText);
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errorDetail: `JSON parse failed: ${message}` };
  }

  const validated = schema.safeParse(parsed);

  if (!validated.success) {
    return {
      ok: false,
      errorDetail: `Schema validation failed: ${formatZodIssues(validated.error)}`,
    };
  }

  return { ok: true, value: validated.data };
}

function buildRetryMessages(messages: ChatMessage[], rawText: string, errorDetail: string): ChatMessage[] {
  return [
    ...messages,
    { role: 'assistant', content: rawText },
    {
      role: 'user',
      content: [
        'The previous response was invalid structured output.',
        `Error detail: ${errorDetail}`,
        'Return only valid JSON that matches the requested schema.',
      ].join('\n'),
    },
  ];
}

function hasImageContent(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url'),
  );
}

export abstract class OpenAICompatibleProvider implements StructuredOutputProvider {
  readonly name: string;
  readonly model: string;
  readonly apiKeyEnv: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetchImpl: FetchLike;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.name = options.name;
    this.model = options.model;
    this.apiKeyEnv = options.apiKeyEnv;
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ChatCompletionRequest): Promise<string> {
    let response: Response;
    let payload: OpenAIChatCompletionResponse;
    const timeoutMs = hasImageContent(request.messages)
      ? MODEL_REQUEST_TIMEOUT_MS.vision
      : MODEL_REQUEST_TIMEOUT_MS.text;
    const abortController = new AbortController();
    let didTimeout = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const timeoutError = () =>
      new ProviderRequestError({
        message: `模型请求超时（${timeoutMs / 1_000} 秒），请检查网络后重试`,
        provider: this.name,
        model: this.model,
        code: 'PROVIDER_REQUEST_TIMEOUT',
      });

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        didTimeout = true;
        reject(timeoutError());
        abortController.abort();
      }, timeoutMs);
    });

    try {
      try {
        response = await Promise.race([
          this.fetchImpl(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: this.model,
              messages: request.messages,
              temperature: request.temperature ?? 0,
              max_tokens: request.maxOutputTokens,
              response_format: request.responseFormat,
            }),
            signal: abortController.signal,
          }),
          timeoutPromise,
        ]);
      } catch (error) {
        if (didTimeout) {
          throw timeoutError();
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new ProviderRequestError({
          message: `${this.name} request failed: ${message}`,
          provider: this.name,
          model: this.model,
        });
      }

      try {
        payload = await Promise.race([
          response.json() as Promise<OpenAIChatCompletionResponse>,
          timeoutPromise,
        ]);
      } catch (error) {
        if (didTimeout) {
          throw timeoutError();
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new ProviderRequestError({
          message: `${this.name} returned a non-JSON response: ${message}`,
          provider: this.name,
          model: this.model,
          statusCode: response.status,
        });
      }
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }

    if (!response.ok) {
      const errorMessage =
        payload.error?.message ??
        `${this.name} request failed with status ${response.status}`;
      throw new ProviderRequestError({
        message: errorMessage,
        provider: this.name,
        model: this.model,
        statusCode: response.status,
        code: payload.error?.code ?? 'PROVIDER_REQUEST_ERROR',
      });
    }

    const content = payload.choices?.[0]?.message?.content;

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((part) => part.text ?? '')
        .join('\n')
        .trim();
    }

    throw new ProviderRequestError({
      message: `${this.name} returned an empty response body`,
      provider: this.name,
      model: this.model,
      statusCode: response.status,
    });
  }

  async generateStructuredOutput<T>(request: StructuredOutputRequest<T>): Promise<T> {
    let currentMessages = request.messages;
    let lastRawText = '';
    let lastErrorDetail = '';

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      lastRawText = await this.complete({
        messages: currentMessages,
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        responseFormat: request.responseFormat ?? { type: 'json_object' },
      });

      const parsed = await parseStructuredText(request.schema, lastRawText);

      if (parsed.ok) {
        return parsed.value;
      }

      lastErrorDetail = parsed.errorDetail;

      if (attempt === 1) {
        currentMessages = buildRetryMessages(request.messages, lastRawText, lastErrorDetail);
      }
    }

    throw new StructuredOutputError({
      message: `${this.name} returned invalid structured output after 2 attempts: ${lastErrorDetail}`,
      provider: this.name,
      model: this.model,
      rawText: lastRawText,
      attempt: 2,
    });
  }
}

class TextProvider extends OpenAICompatibleProvider {}

function normalizeOptionalValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function createTextProvider(options: TextProviderOptions): OpenAICompatibleProvider {
  const deepseekApiKey = normalizeOptionalValue(options.deepseekApiKey);

  if (deepseekApiKey) {
    return new TextProvider({
      name: 'DeepSeek',
      model: normalizeOptionalValue(options.deepseekModel) ?? DEFAULT_DEEPSEEK_MODEL,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      apiKey: deepseekApiKey,
      baseUrl: options.deepseekBaseUrl ?? DEFAULT_DEEPSEEK_BASE_URL,
      fetchImpl: options.fetchImpl,
    });
  }

  const dashscopeApiKey = normalizeOptionalValue(options.dashscopeApiKey);

  if (!dashscopeApiKey) {
    throw new ConfigurationError(
      'Missing required environment variable DASHSCOPE_API_KEY',
      'DASHSCOPE_API_KEY',
      'CONFIG_ERROR',
    );
  }

  return new TextProvider({
    name: 'Qwen',
    model: normalizeOptionalValue(options.qwenTextModel) ?? DEFAULT_QWEN_TEXT_MODEL,
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    apiKey: dashscopeApiKey,
    baseUrl: options.dashscopeBaseUrl ?? DEFAULT_QWEN_TEXT_BASE_URL,
    fetchImpl: options.fetchImpl,
  });
}
