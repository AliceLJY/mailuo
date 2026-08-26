import Constants from "expo-constants";
import { File as ExpoFile } from "expo-file-system";
import * as Linking from "expo-linking";
import { Platform } from "react-native";

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

export function getErrorMessage(error: unknown, fallback = "请求失败，请稍后再试。") {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

export function isConflictError(error: unknown) {
  return error instanceof ApiError && error.status === 409;
}

function getBaseUrl() {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/u, "");

  if (!baseUrl) {
    const appName = Constants.expoConfig?.name ?? "当前 Expo App";
    const launchUrl = Linking.createURL("/");
    throw new ApiError(
      `${appName} 缺少 EXPO_PUBLIC_API_URL。当前入口是 ${launchUrl}，请先配置 app/.env。`,
      500,
      "CONFIG_ERROR",
    );
  }

  return baseUrl;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${getBaseUrl()}${path}`, init);
  const payload = (await response.json()) as ApiResponse<T>;

  if (!response.ok || !payload.ok) {
    const message = payload.ok ? "请求失败" : payload.error.message;
    const code = payload.ok ? undefined : payload.error.code;
    const details = payload.ok ? undefined : payload.error.details;
    throw new ApiError(message, response.status, code, details);
  }

  return payload.data;
}

function resolveUploadFileName(asset: UploadImageAsset): string {
  return (
    asset.fileName?.trim() ||
    asset.uri.split("/").filter(Boolean).at(-1) ||
    `screenshot-${Date.now()}.jpg`
  );
}

// SDK 57 的全局 fetch 是 WinterCG 实现，不再接受 RN 老式 {uri,name,type} 上传对象
// （报 "unsupported FormDataPart implementation"）；native 走 expo-file-system 的
// 标准 File（实现 Blob 接口），web 走真 Blob。
async function buildUploadBlob(asset: UploadImageAsset): Promise<Blob> {
  if (Platform.OS === "web") {
    const response = await fetch(asset.uri);
    return await response.blob();
  }

  return new ExpoFile(asset.uri) as unknown as Blob;
}

export async function uploadScreenshot(input: {
  asset: UploadImageAsset;
  note?: string;
}) {
  const formData = new FormData();
  formData.append(
    "image",
    await buildUploadBlob(input.asset),
    resolveUploadFileName(input.asset),
  );

  if (input.note?.trim()) {
    formData.append("note", input.note.trim());
  }

  return request<ScreenshotUploadResponse>("/api/screenshots", {
    method: "POST",
    body: formData,
  });
}

export async function confirmCard(cardId: number, body: ConfirmCardRequest = {}) {
  return request<ConfirmCardResponse>(`/api/cards/${cardId}/confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export async function rejectCard(cardId: number) {
  return request<RejectCardResponse>(`/api/cards/${cardId}/reject`, {
    method: "POST",
  });
}

export async function getContacts() {
  return request<ContactListItem[]>("/api/contacts");
}

export async function getContactDetail(contactId: number) {
  return request<ContactDetail>(`/api/contacts/${contactId}`);
}

export async function getMeetings() {
  return request<MeetingRecord[]>("/api/meetings");
}

export async function getScreenshotDetail(screenshotId: number) {
  return request<ScreenshotDetail>(`/api/screenshots/${screenshotId}`);
}

export async function getHealth() {
  return request<HealthResponse>("/api/health");
}

export function getConfiguredApiUrl() {
  return process.env.EXPO_PUBLIC_API_URL?.trim() ?? "";
}
