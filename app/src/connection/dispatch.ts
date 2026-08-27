import type {
  ConfirmCardRequest,
  ConfirmCardResponse,
  ContactDetail,
  ContactListItem,
  MeetingRecord,
  RejectCardResponse,
  ScreenshotDetail,
  ScreenshotUploadResponse,
  UploadImageAsset,
} from "../types";

import type { ConnectionConfigStore } from "./config";

export interface RoutedApi {
  uploadScreenshot(input: {
    asset: UploadImageAsset;
    note?: string;
  }): Promise<ScreenshotUploadResponse>;
  confirmCard(cardId: number, body?: ConfirmCardRequest): Promise<ConfirmCardResponse>;
  rejectCard(cardId: number): Promise<RejectCardResponse>;
  getContacts(): Promise<ContactListItem[]>;
  getContactDetail(contactId: number): Promise<ContactDetail>;
  getMeetings(): Promise<MeetingRecord[]>;
  getScreenshotDetail(screenshotId: number): Promise<ScreenshotDetail>;
}

export type ApiPlatform = "android" | "ios" | "web";

type ApiDispatcherOptions = {
  configStore: ConnectionConfigStore;
  platform: ApiPlatform;
  publicApiUrl?: string;
  createServerApi(serverUrl?: string): RoutedApi;
  getLocalApi(): Promise<RoutedApi>;
};

function normalizeServerUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\/+$/u, "");
  return normalized || undefined;
}

export async function selectApiTarget(options: Pick<
  ApiDispatcherOptions,
  "configStore" | "platform" | "publicApiUrl"
>) {
  const config = await options.configStore.get();

  if (options.platform !== "web" && config?.mode === "local") {
    return { mode: "local" as const };
  }

  return {
    mode: "server" as const,
    serverUrl: normalizeServerUrl(config?.serverUrl ?? options.publicApiUrl),
  };
}

export function createApiDispatcher(options: ApiDispatcherOptions): RoutedApi {
  async function selectedApi(): Promise<RoutedApi> {
    const target = await selectApiTarget(options);

    if (target.mode === "local") {
      return options.getLocalApi();
    }

    return options.createServerApi(target.serverUrl);
  }

  return {
    async uploadScreenshot(input) {
      return (await selectedApi()).uploadScreenshot(input);
    },
    async confirmCard(cardId, body = {}) {
      return (await selectedApi()).confirmCard(cardId, body);
    },
    async rejectCard(cardId) {
      return (await selectedApi()).rejectCard(cardId);
    },
    async getContacts() {
      return (await selectedApi()).getContacts();
    },
    async getContactDetail(contactId) {
      return (await selectedApi()).getContactDetail(contactId);
    },
    async getMeetings() {
      return (await selectedApi()).getMeetings();
    },
    async getScreenshotDetail(screenshotId) {
      return (await selectedApi()).getScreenshotDetail(screenshotId);
    },
  };
}
