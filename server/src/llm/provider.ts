import { z } from 'zod';

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

type OpenAICompatibleProviderOptions = {
  name: string;
  model: string;
  apiKeyEnv: string;
  apiKey: string;
  baseUrl: string;
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

export function requireEnv(envName: string, value = process.env[envName]): string {
  if (!value) {
    throw new ConfigurationError(
      `Missing required environment variable ${envName}`,
      envName,
      'CONFIG_ERROR',
    );
  }

  return value;
}

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

    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderRequestError({
        message: `${this.name} request failed: ${message}`,
        provider: this.name,
        model: this.model,
      });
    }

    let payload: OpenAIChatCompletionResponse;

    try {
      payload = (await response.json()) as OpenAIChatCompletionResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderRequestError({
        message: `${this.name} returned a non-JSON response: ${message}`,
        provider: this.name,
        model: this.model,
        statusCode: response.status,
      });
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
