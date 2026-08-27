export const LOCAL_LLM_SECRET_NAMES = [
  "DASHSCOPE_API_KEY",
  "DEEPSEEK_API_KEY",
  "QWEN_MODEL",
  "QWEN_TEXT_MODEL",
  "DEEPSEEK_MODEL",
] as const;

export type LocalLlmSecretName = (typeof LOCAL_LLM_SECRET_NAMES)[number];

export interface SecretStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export interface LocalLlmSecretStore {
  get(name: LocalLlmSecretName): Promise<string | null>;
  set(name: LocalLlmSecretName, value: string): Promise<void>;
  clear(name: LocalLlmSecretName): Promise<void>;
  clearAll(): Promise<void>;
}

const SECRET_KEY_PREFIX = "mailuo.byok.";

function storageKey(name: LocalLlmSecretName): string {
  return `${SECRET_KEY_PREFIX}${name}`;
}

export function createLocalLlmSecretStore(storage: SecretStorage): LocalLlmSecretStore {
  return {
    async get(name) {
      const value = await storage.getItem(storageKey(name));
      const normalized = value?.trim();
      return normalized || null;
    },
    async set(name, value) {
      const normalized = value.trim();

      if (!normalized) {
        throw new TypeError(`${name} 不能为空`);
      }

      await storage.setItem(storageKey(name), normalized);
    },
    async clear(name) {
      await storage.deleteItem(storageKey(name));
    },
    async clearAll() {
      await Promise.all(
        LOCAL_LLM_SECRET_NAMES.map((name) => storage.deleteItem(storageKey(name))),
      );
    },
  };
}
