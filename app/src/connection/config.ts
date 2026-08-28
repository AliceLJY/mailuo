export type PerceptionPath = "ocr" | "cloud";

export type ConnectionConfig = {
  mode: "server" | "local";
  serverUrl?: string;
  perceptionPath?: PerceptionPath;
  exportOcrResults?: boolean;
};

export type LocalProcessingSettings = {
  perceptionPath: PerceptionPath;
  exportOcrResults: boolean;
};

export interface TextStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface ConnectionConfigStore {
  get(): Promise<ConnectionConfig | null>;
  set(config: ConnectionConfig): Promise<void>;
  clear(): Promise<void>;
}

const CONNECTION_CONFIG_KEY = "mailuo.connection.v2";

function normalizeServerUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\/+$/u, "");
  return normalized || undefined;
}

export function getLocalProcessingSettings(
  config: ConnectionConfig | null | undefined,
): LocalProcessingSettings {
  return {
    perceptionPath: config?.perceptionPath === "cloud" ? "cloud" : "ocr",
    exportOcrResults: config?.exportOcrResults === true,
  };
}

function parseConnectionConfig(value: string | null): ConnectionConfig | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<ConnectionConfig> | null;

    if (!parsed || (parsed.mode !== "server" && parsed.mode !== "local")) {
      return null;
    }

    const serverUrl = normalizeServerUrl(parsed.serverUrl);
    const processing = getLocalProcessingSettings(parsed as ConnectionConfig);
    return {
      mode: parsed.mode,
      ...(serverUrl ? { serverUrl } : {}),
      ...(processing.perceptionPath === "cloud" ? { perceptionPath: "cloud" as const } : {}),
      ...(processing.exportOcrResults ? { exportOcrResults: true } : {}),
    };
  } catch {
    return null;
  }
}

export function createConnectionConfigStore(storage: TextStorage): ConnectionConfigStore {
  return {
    async get() {
      return parseConnectionConfig(await storage.getItem(CONNECTION_CONFIG_KEY));
    },
    async set(config) {
      const serverUrl = normalizeServerUrl(config.serverUrl);
      const processing = getLocalProcessingSettings(config);
      await storage.setItem(
        CONNECTION_CONFIG_KEY,
        JSON.stringify({
          mode: config.mode,
          ...(serverUrl ? { serverUrl } : {}),
          ...(processing.perceptionPath === "cloud" ? { perceptionPath: "cloud" as const } : {}),
          ...(processing.exportOcrResults ? { exportOcrResults: true } : {}),
        } satisfies ConnectionConfig),
      );
    },
    async clear() {
      await storage.removeItem(CONNECTION_CONFIG_KEY);
    },
  };
}
