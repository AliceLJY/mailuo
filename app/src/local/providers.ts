import {
  ConfigurationError,
  OpenAICompatibleProvider,
  type FetchLike,
  type StructuredOutputProvider,
} from "../../../shared/core/llm/provider.ts";
import type { LocalLlmSecretStore } from "../connection/secrets";

const DEFAULT_QWEN_MODEL = "qwen-vl-max";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

class ByokProvider extends OpenAICompatibleProvider {}

export interface LocalProviderFactory {
  createQwenProvider(keys: LocalLlmSecretStore): Promise<StructuredOutputProvider>;
  createDeepSeekProvider(keys: LocalLlmSecretStore): Promise<StructuredOutputProvider>;
}

async function requireStoredValue(
  keys: LocalLlmSecretStore,
  name: "DASHSCOPE_API_KEY" | "DEEPSEEK_API_KEY",
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
    async createDeepSeekProvider(keys) {
      return new ByokProvider({
        name: "DeepSeek",
        model: (await keys.get("DEEPSEEK_MODEL")) ?? DEFAULT_DEEPSEEK_MODEL,
        apiKeyEnv: "DEEPSEEK_API_KEY",
        apiKey: await requireStoredValue(keys, "DEEPSEEK_API_KEY"),
        baseUrl: DEEPSEEK_BASE_URL,
        fetchImpl,
      });
    },
  };
}
