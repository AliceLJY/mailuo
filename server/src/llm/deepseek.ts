import { OpenAICompatibleProvider, type FetchLike, requireEnv } from './provider.ts';

const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

type DeepSeekProviderOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
};

function normalizeConfiguredModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}

function getDeepSeekModel(
  optionModel: string | undefined,
  env = process.env,
): string {
  return normalizeConfiguredModel(optionModel) ??
    normalizeConfiguredModel(env.DEEPSEEK_MODEL) ??
    DEFAULT_DEEPSEEK_MODEL;
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(options: DeepSeekProviderOptions = {}) {
    const apiKey = options.apiKey ?? requireEnv('DEEPSEEK_API_KEY');

    super({
      name: 'DeepSeek',
      model: getDeepSeekModel(options.model),
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      apiKey,
      baseUrl: options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_DEEPSEEK_BASE_URL,
      fetchImpl: options.fetchImpl,
    });
  }
}

export function createDeepSeekProvider(options: DeepSeekProviderOptions = {}): DeepSeekProvider {
  return new DeepSeekProvider(options);
}
