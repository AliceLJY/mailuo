import {
  createTextProvider as createCoreTextProvider,
  type FetchLike,
  type StructuredOutputProvider,
} from '../../../shared/core/llm/provider.ts';

export type TextProviderOptions = {
  dashscopeApiKey?: string;
  deepseekApiKey?: string;
  qwenTextModel?: string;
  deepseekModel?: string;
  dashscopeBaseUrl?: string;
  deepseekBaseUrl?: string;
  fetchImpl?: FetchLike;
};

export function createTextProvider(options: TextProviderOptions = {}): StructuredOutputProvider {
  return createCoreTextProvider({
    dashscopeApiKey: options.dashscopeApiKey ?? process.env.DASHSCOPE_API_KEY,
    deepseekApiKey: options.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY,
    qwenTextModel: options.qwenTextModel ?? process.env.QWEN_TEXT_MODEL,
    deepseekModel: options.deepseekModel ?? process.env.DEEPSEEK_MODEL,
    dashscopeBaseUrl: options.dashscopeBaseUrl ?? process.env.DASHSCOPE_BASE_URL,
    deepseekBaseUrl: options.deepseekBaseUrl ?? process.env.DEEPSEEK_BASE_URL,
    fetchImpl: options.fetchImpl,
  });
}
