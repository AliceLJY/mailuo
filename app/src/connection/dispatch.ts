import type {
  ActionCardRecord,
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
import type { LocalBatchContactSession } from "../local/batch-contacts";
import type { DiagnosticsSnapshot } from "../local/types";

import type { ConnectionConfigStore } from "./config";

export type ApiTargetExpectation =
  | { mode: "local" }
  | { mode: "server"; serverUrl: string | null };

export type UploadTextInput = {
  text: string;
  note?: string;
  expectedTarget?: ApiTargetExpectation;
};

type UploadTextFn = (input: UploadTextInput) => Promise<ScreenshotUploadResponse>;

export interface RoutedApi {
  uploadScreenshot(input: {
    asset: UploadImageAsset;
    note?: string;
    expectedTarget?: ApiTargetExpectation;
    localBatch?: {
      session: LocalBatchContactSession;
      index: number;
    };
  }): Promise<ScreenshotUploadResponse>;
  uploadText: UploadTextFn;
  confirmCard(cardId: number, body?: ConfirmCardRequest): Promise<ConfirmCardResponse>;
  rejectCard(cardId: number): Promise<RejectCardResponse>;
  reopenCard(cardId: number): Promise<{ card: ActionCardRecord }>;
  countPendingLocalBatchInteractionCards(anchorCardId: number): Promise<number>;
  readDiagnosticsSnapshot(): Promise<DiagnosticsSnapshot>;
  clearAllData(): Promise<void>;
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

export class ApiTargetChangedError extends Error {
  readonly code = "BATCH_TARGET_CHANGED";

  constructor(
    readonly expectedTarget: ApiTargetExpectation,
    readonly actualTarget:
      | { mode: "local" }
      | { mode: "server"; serverUrl?: string },
  ) {
    super("处理目标已变更，请切回本批次的处理模式与服务地址，或开始新一批。");
    this.name = "ApiTargetChangedError";
  }
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
  async function selectedApi(
    expectedTarget?: ApiTargetExpectation,
  ): Promise<RoutedApi> {
    const target = await selectApiTarget(options);

    const targetChanged = expectedTarget && (
      target.mode !== expectedTarget.mode ||
      (
        target.mode === "server" &&
        expectedTarget.mode === "server" &&
        normalizeServerUrl(target.serverUrl) !==
          normalizeServerUrl(expectedTarget.serverUrl ?? undefined)
      )
    );
    if (targetChanged) {
      throw new ApiTargetChangedError(expectedTarget, target);
    }

    if (target.mode === "local") {
      return options.getLocalApi();
    }

    return options.createServerApi(target.serverUrl);
  }

  return {
    async uploadScreenshot(input) {
      const { expectedTarget, ...routedInput } = input;
      return (await selectedApi(expectedTarget)).uploadScreenshot(routedInput);
    },
    async uploadText(input) {
      const { expectedTarget, ...routedInput } = input;
      const api = await selectedApi(expectedTarget);
      return api.uploadText(routedInput);
    },
    async confirmCard(cardId, body = {}) {
      return (await selectedApi()).confirmCard(cardId, body);
    },
    async rejectCard(cardId) {
      return (await selectedApi()).rejectCard(cardId);
    },
    async reopenCard(cardId) {
      return (await selectedApi()).reopenCard(cardId);
    },
    async countPendingLocalBatchInteractionCards(anchorCardId) {
      return (await selectedApi()).countPendingLocalBatchInteractionCards(anchorCardId);
    },
    async readDiagnosticsSnapshot() {
      return (await selectedApi()).readDiagnosticsSnapshot();
    },
    async clearAllData() {
      return (await selectedApi()).clearAllData();
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
