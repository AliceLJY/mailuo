import {
  ConfigurationError,
  OpenAICompatibleProvider,
  createTextProvider as createCoreTextProvider,
  type FetchLike,
  type StructuredOutputProvider,
} from "../../../shared/core/llm/provider.ts";
import type { LocalLlmSecretStore } from "../connection/secrets";

const DEFAULT_QWEN_MODEL = "qwen-vl-max";
const DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

class ByokProvider extends OpenAICompatibleProvider {}

export interface LocalProviderFactory {
  createQwenProvider(keys: LocalLlmSecretStore): Promise<StructuredOutputProvider>;
  createTextProvider(keys: LocalLlmSecretStore): Promise<StructuredOutputProvider>;
}

async function requireStoredValue(
  keys: LocalLlmSecretStore,
  name: "DASHSCOPE_API_KEY",
) {
  const value = await keys.get(name);

  if (!value) {
    throw new ConfigurationError(
      `缺少 ${name}，请先完成 API key 配置。`,
      name,
      "CONFIG_ERROR",
    );
  }

  return value;
}

export function createLocalProviderFactory(fetchImpl?: FetchLike): LocalProviderFactory {
  return {
    async createQwenProvider(keys) {
      return new ByokProvider({
        name: "Qwen",
        model: (await keys.get("QWEN_MODEL")) ?? DEFAULT_QWEN_MODEL,
        apiKeyEnv: "DASHSCOPE_API_KEY",
        apiKey: await requireStoredValue(keys, "DASHSCOPE_API_KEY"),
        baseUrl: DASHSCOPE_BASE_URL,
        fetchImpl,
      });
    },
    async createTextProvider(keys) {
      const [dashscopeApiKey, deepseekApiKey, qwenTextModel, deepseekModel] = await Promise.all([
        keys.get("DASHSCOPE_API_KEY"),
        keys.get("DEEPSEEK_API_KEY"),
        keys.get("QWEN_TEXT_MODEL"),
        keys.get("DEEPSEEK_MODEL"),
      ]);

      return createCoreTextProvider({
        dashscopeApiKey,
        deepseekApiKey,
        qwenTextModel,
        deepseekModel,
        fetchImpl,
      });
    },
  };
}
