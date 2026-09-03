export type PerceptionPath = "ocr" | "cloud";

export type ConnectionConfig = {
  mode: "server" | "local";
  serverUrl?: string;
  perceptionPath?: PerceptionPath;
  exportOcrResults?: boolean;
  selfNames?: string[];
};

export type LocalProcessingSettings = {
  perceptionPath: PerceptionPath;
  exportOcrResults: boolean;
  selfNames: string[];
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

function normalizeComparableName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function normalizeSelfNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const names: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const name = entry.trim().replace(/\s+/gu, " ");
    const comparableName = normalizeComparableName(name);

    if (!comparableName || seen.has(comparableName)) {
      continue;
    }

    seen.add(comparableName);
    names.push(name);
  }

  return names;
}

export function parseSelfNamesInput(value: string): string[] {
  return normalizeSelfNames(value.split(/[,，]/u));
}

export function getLocalProcessingSettings(
  config: ConnectionConfig | null | undefined,
): LocalProcessingSettings {
  return {
    perceptionPath: config?.perceptionPath === "cloud" ? "cloud" : "ocr",
    exportOcrResults: config?.exportOcrResults === true,
    selfNames: normalizeSelfNames(config?.selfNames),
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
      ...(processing.selfNames.length > 0 ? { selfNames: processing.selfNames } : {}),
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
          ...(processing.selfNames.length > 0 ? { selfNames: processing.selfNames } : {}),
        } satisfies ConnectionConfig),
      );
    },
    async clear() {
      await storage.removeItem(CONNECTION_CONFIG_KEY);
    },
  };
}
