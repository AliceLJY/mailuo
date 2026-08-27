import type { ConnectionConfig } from "./config";
import type { ApiPlatform } from "./dispatch";

export type StartupDestination = "guide" | "home" | "server-form";

function hasPublicServerUrl(value: string | undefined) {
  return Boolean(value?.trim());
}

export function resolveStartupDestination(
  config: ConnectionConfig | null,
  platform: ApiPlatform,
  publicApiUrl?: string,
): StartupDestination {
  if (config?.mode === "local") {
    return platform === "web" ? "server-form" : "home";
  }

  if (config?.mode === "server") {
    return "home";
  }

  return hasPublicServerUrl(publicApiUrl) ? "home" : "guide";
}
