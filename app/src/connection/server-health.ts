import type { ApiResponse, HealthResponse } from "../types";

export class ServerConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerConnectionError";
  }
}

export type ServerHealthResult = {
  latencyMs: number;
  serverUrl: string;
};

function normalizeServerAddress(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ServerConnectionError(
      "地址格式不对，请填写以 http:// 或 https:// 开头的完整地址。",
    );
  }

  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new ServerConnectionError(
      "地址格式不对，请填写以 http:// 或 https:// 开头的完整地址。",
    );
  }

  if (parsed.username || parsed.password) {
    throw new ServerConnectionError("服务器地址不能包含账号或密码。");
  }

  if (parsed.search || parsed.hash) {
    throw new ServerConnectionError("服务器地址不要带问号参数或页面位置。");
  }

  return parsed.toString().replace(/\/+$/u, "");
}

export async function testServerConnection(
  value: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<ServerHealthResult> {
  const serverUrl = normalizeServerAddress(value);
  const startedAt = now();
  let response: Response;

  try {
    response = await fetchImpl(`${serverUrl}/api/health`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new ServerConnectionError("现在连不上这个服务器，请检查地址和网络后再试。");
  }

  if (!response.ok) {
    throw new ServerConnectionError(
      `服务器返回 ${response.status}，请确认这是脉络后端地址。`,
    );
  }

  let payload: ApiResponse<HealthResponse>;

  try {
    payload = (await response.json()) as ApiResponse<HealthResponse>;
  } catch {
    throw new ServerConnectionError("这个地址有响应，但没有找到脉络服务。");
  }

  if (!payload.ok || payload.data.status !== "ok") {
    throw new ServerConnectionError("这个地址有响应，但没有找到脉络服务。");
  }

  return {
    latencyMs: Math.max(0, Math.round(now() - startedAt)),
    serverUrl,
  };
}
