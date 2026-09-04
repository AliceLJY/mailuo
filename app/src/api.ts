import Constants from "expo-constants";
import { File as ExpoFile } from "expo-file-system";
import * as Linking from "expo-linking";
import { Platform } from "react-native";

import { connectionConfigStore } from "@/connection/config-runtime";
import {
  createApiDispatcher,
  type ApiPlatform,
  type RoutedApi,
} from "@/connection/dispatch";
import { prepareScreenshotForUpload } from "@/upload-image";
import type {
  ApiResponse,
  ConfirmCardRequest,
  ConfirmCardResponse,
  ContactDetail,
  ContactListItem,
  HealthResponse,
  MeetingRecord,
  RejectCardResponse,
  ScreenshotDetail,
  ScreenshotUploadResponse,
  UploadImageAsset,
} from "@/types";

export class ApiError extends Error {
  code?: string;
  details?: unknown;
  status: number;

  constructor(message: string, status = 500, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function getErrorMessage(error: unknown, fallback = "暂时没成功，请稍后再试。") {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

export function isConflictError(error: unknown) {
  return (
    (error instanceof ApiError && error.status === 409) ||
    (typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 409)
  );
}

function resolveConfiguredApiUrl() {
  return process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/u, "") ?? "";
}

export function getBaseUrl(configuredUrl?: string) {
  const baseUrl = configuredUrl?.trim().replace(/\/+$/u, "") || resolveConfiguredApiUrl();

  if (baseUrl) {
    return baseUrl;
  }

  if (Platform.OS === "web") {
    return "";
  }

  const appName = Constants.expoConfig?.name ?? "当前应用";
  const launchUrl = Linking.createURL("/");
  throw new ApiError(
    `${appName} 还没设置服务地址，请先完成配置后再打开。`,
    500,
    "CONFIG_ERROR",
    { launchUrl, missingKey: "EXPO_PUBLIC_API_URL" },
  );
}

async function request<T>(path: string, init?: RequestInit, serverUrl?: string): Promise<T> {
  const response = await fetch(`${getBaseUrl(serverUrl)}${path}`, init);
  const payload = (await response.json()) as ApiResponse<T>;

  if (!response.ok || !payload.ok) {
    const message = payload.ok ? "暂时没成功" : payload.error.message;
    const code = payload.ok ? undefined : payload.error.code;
    const details = payload.ok ? undefined : payload.error.details;
    throw new ApiError(message, response.status, code, details);
  }

  return payload.data;
}

// SDK 57 的全局 fetch 是 WinterCG 实现，不再接受 RN 老式 {uri,name,type} 上传对象
// （报 "unsupported FormDataPart implementation"）；native 走 expo-file-system 的
// 标准 File（实现 Blob 接口），web 走真 Blob。
async function buildUploadBlob(asset: { uri: string }): Promise<Blob> {
  if (Platform.OS === "web") {
    const response = await fetch(asset.uri);
    return await response.blob();
  }

  return new ExpoFile(asset.uri) as unknown as Blob;
}

async function cleanupPreparedUploadAsset(cleanup?: () => void) {
  if (!cleanup) {
    return;
  }

  try {
    cleanup();
  } catch (error) {
    if (__DEV__) {
      console.warn("截图上传缓存清理失败", error);
    }
  }
}

async function uploadScreenshotFromServer(input: {
  asset: UploadImageAsset;
  note?: string;
}, serverUrl?: string) {
  const preparedAsset = await prepareScreenshotForUpload(input.asset);

  try {
    const formData = new FormData();

    formData.append(
      "image",
      await buildUploadBlob(preparedAsset),
      preparedAsset.fileName,
    );

    if (input.note?.trim()) {
      formData.append("note", input.note.trim());
    }

    return await request<ScreenshotUploadResponse>("/api/screenshots", {
      method: "POST",
      body: formData,
    }, serverUrl);
  } finally {
    await cleanupPreparedUploadAsset(preparedAsset.cleanup);
  }
}

async function uploadTextFromServer(input: {
  text: string;
  note?: string;
}, serverUrl?: string) {
  const note = input.note?.trim();
  return request<ScreenshotUploadResponse>("/api/notes", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      text: input.text.trim(),
      ...(note ? { note } : {}),
    }),
  }, serverUrl);
}

async function confirmCardFromServer(
  cardId: number,
  body: ConfirmCardRequest = {},
  serverUrl?: string,
) {
  return request<ConfirmCardResponse>(`/api/cards/${cardId}/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }, serverUrl);
}

async function rejectCardFromServer(cardId: number, serverUrl?: string) {
  return request<RejectCardResponse>(`/api/cards/${cardId}/reject`, {
    method: "POST",
  }, serverUrl);
}

async function getContactsFromServer(serverUrl?: string) {
  return request<ContactListItem[]>("/api/contacts", undefined, serverUrl);
}

async function getContactDetailFromServer(contactId: number, serverUrl?: string) {
  return request<ContactDetail>(`/api/contacts/${contactId}`, undefined, serverUrl);
}

async function getMeetingsFromServer(serverUrl?: string) {
  return request<MeetingRecord[]>("/api/meetings", undefined, serverUrl);
}

async function getScreenshotDetailFromServer(screenshotId: number, serverUrl?: string) {
  return request<ScreenshotDetail>(`/api/screenshots/${screenshotId}`, undefined, serverUrl);
}

function createServerApi(serverUrl?: string): RoutedApi {
  return {
    uploadScreenshot: (input) => uploadScreenshotFromServer(input, serverUrl),
    uploadText: (input) => uploadTextFromServer(input, serverUrl),
    confirmCard: (cardId, body = {}) => confirmCardFromServer(cardId, body, serverUrl),
    rejectCard: (cardId) => rejectCardFromServer(cardId, serverUrl),
    async reopenCard() {
      throw new ApiError("服务器模式暂不支持恢复已跳过的卡片。", 501, "NOT_SUPPORTED");
    },
    async countPendingLocalBatchInteractionCards() {
      return 0;
    },
    async readDiagnosticsSnapshot() {
      throw new ApiError("服务器模式暂不支持读取诊断快照。", 501, "NOT_SUPPORTED");
    },
    async clearAllData() {
      throw new ApiError("服务器模式暂不支持清空全部数据。", 501, "NOT_SUPPORTED");
    },
    getContacts: () => getContactsFromServer(serverUrl),
    getContactDetail: (contactId) => getContactDetailFromServer(contactId, serverUrl),
    getMeetings: () => getMeetingsFromServer(serverUrl),
    getScreenshotDetail: (screenshotId) =>
      getScreenshotDetailFromServer(screenshotId, serverUrl),
  };
}

function getApiPlatform(): ApiPlatform {
  if (Platform.OS === "web") {
    return "web";
  }

  return Platform.OS === "ios" ? "ios" : "android";
}

const apiDispatcher = createApiDispatcher({
  configStore: connectionConfigStore,
  platform: getApiPlatform(),
  publicApiUrl: resolveConfiguredApiUrl(),
  createServerApi,
  async getLocalApi() {
    const { getExpoLocalApi } = await import("@/local/runtime");
    return getExpoLocalApi();
  },
});

export const uploadScreenshot = apiDispatcher.uploadScreenshot;
export const uploadText = apiDispatcher.uploadText;
export const confirmCard = apiDispatcher.confirmCard;
export const rejectCard = apiDispatcher.rejectCard;
export const reopenCard = apiDispatcher.reopenCard;
export const countPendingLocalBatchInteractionCards =
  apiDispatcher.countPendingLocalBatchInteractionCards;
export const readDiagnosticsSnapshot = apiDispatcher.readDiagnosticsSnapshot;
export const clearAllData = apiDispatcher.clearAllData;
export const getContacts = apiDispatcher.getContacts;
export const getContactDetail = apiDispatcher.getContactDetail;
export const getMeetings = apiDispatcher.getMeetings;
export const getScreenshotDetail = apiDispatcher.getScreenshotDetail;

export async function getHealth() {
  return request<HealthResponse>("/api/health");
}

export function getConfiguredApiUrl() {
  return resolveConfiguredApiUrl();
}
