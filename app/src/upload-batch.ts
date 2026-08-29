import type { ScreenshotUploadResponse, UploadImageAsset } from "./types";

export type UploadBatchMode = "local" | "server";
export type UploadBatchStatus = "success" | "partial_success" | "failed";

type UploadBatchItemBase = {
  asset: UploadImageAsset;
  fileName: string;
  index: number;
};

export type UploadBatchSuccessItem = UploadBatchItemBase & {
  status: "success";
  response: ScreenshotUploadResponse;
};

export type UploadBatchFailureItem = UploadBatchItemBase & {
  status: "failure";
  reason: string;
};

export type UploadBatchItem = UploadBatchSuccessItem | UploadBatchFailureItem;

export type UploadBatchSourceItem = {
  asset: UploadImageAsset;
  index: number;
};

export type UploadBatchResult = {
  mode: UploadBatchMode;
  serverUrl: string | null;
  status: UploadBatchStatus;
  totalCount: number;
  successCount: number;
  failureCount: number;
  items: UploadBatchItem[];
};

export type UploadBatchProgress = {
  mode: UploadBatchMode;
  asset: UploadImageAsset;
  fileName: string;
  index: number;
  position: number;
  totalCount: number;
} & (
  | { status: "processing" }
  | { status: "success"; response: ScreenshotUploadResponse }
  | { status: "failure"; reason: string }
);

type UploadScreenshotBatchOptionsBase = {
  mode: UploadBatchMode;
  serverUrl?: string | null;
  note?: string;
  uploadScreenshot(input: {
    asset: UploadImageAsset;
    index: number;
    note?: string;
  }): Promise<ScreenshotUploadResponse>;
  onProgress?: (progress: UploadBatchProgress) => void;
  shouldContinue?: () => boolean;
};

export type UploadScreenshotBatchOptions = UploadScreenshotBatchOptionsBase & (
  | {
      assets: UploadImageAsset[];
      items?: never;
    }
  | {
      assets?: never;
      items: UploadBatchSourceItem[];
    }
);

export async function uploadScreenshotBatch({
  assets,
  items: sourceItems,
  mode,
  serverUrl = null,
  note,
  uploadScreenshot,
  onProgress,
  shouldContinue = () => true,
}: UploadScreenshotBatchOptions): Promise<UploadBatchResult> {
  const queuedItems = sourceItems
    ? sourceItems.map((item) => ({ asset: item.asset, index: item.index }))
    : assets.map((asset, index) => ({ asset, index }));
  const items: UploadBatchItem[] = [];

  for (let positionIndex = 0; positionIndex < queuedItems.length; positionIndex += 1) {
    if (!shouldContinue()) {
      break;
    }

    const { asset, index } = queuedItems[positionIndex];
    const fileName = getUploadAssetLabel(asset);
    const progressBase = {
      mode,
      asset,
      fileName,
      index,
      position: positionIndex + 1,
      totalCount: queuedItems.length,
    };

    onProgress?.({ ...progressBase, status: "processing" });
    if (!shouldContinue()) {
      break;
    }

    try {
      const response = await uploadScreenshot({ asset, index, note });
      if (!shouldContinue()) {
        break;
      }
      items.push({
        asset,
        fileName,
        index,
        status: "success",
        response,
      });
      onProgress?.({ ...progressBase, status: "success", response });
    } catch (error) {
      if (!shouldContinue()) {
        break;
      }
      const reason = getUploadFailureReason(error);
      items.push({
        asset,
        fileName,
        index,
        status: "failure",
        reason,
      });
      onProgress?.({ ...progressBase, status: "failure", reason });
    }
  }

  const successCount = items.filter((item) => item.status === "success").length;
  const failureCount = items.length - successCount;

  return {
    mode,
    serverUrl: mode === "server" ? normalizeUploadServerUrl(serverUrl) : null,
    status:
      successCount === 0
        ? "failed"
        : failureCount === 0
          ? "success"
          : "partial_success",
    totalCount: items.length,
    successCount,
    failureCount,
    items,
  };
}

export function getFailedUploadAssets(result: UploadBatchResult): UploadImageAsset[] {
  return getFailedUploadItems(result).map((item) => item.asset);
}

export function getFailedUploadItems(result: UploadBatchResult): UploadBatchFailureItem[] {
  return result.items.filter(
    (item): item is UploadBatchFailureItem => item.status === "failure",
  );
}

export function mergeUploadBatchResults(
  current: UploadBatchResult,
  retry: UploadBatchResult,
): UploadBatchResult {
  if (current.mode !== retry.mode || current.serverUrl !== retry.serverUrl) {
    throw new Error("Cannot merge upload batches from different targets");
  }

  const retriedItems = new Map(retry.items.map((item) => [item.index, item]));
  const items = current.items.map((item) => retriedItems.get(item.index) ?? item);
  const successCount = items.filter((item) => item.status === "success").length;
  const failureCount = items.length - successCount;

  return {
    mode: current.mode,
    serverUrl: current.serverUrl,
    status:
      successCount === 0
        ? "failed"
        : failureCount === 0
          ? "success"
          : "partial_success",
    totalCount: items.length,
    successCount,
    failureCount,
    items,
  };
}

export function normalizeUploadServerUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\/+$/u, "");
  return normalized || null;
}

export function uploadBatchTargetMatches(input: {
  batchMode: UploadBatchMode | null;
  batchServerUrl: string | null;
  currentMode: UploadBatchMode;
  currentServerUrl: string | null;
}) {
  if (!input.batchMode || input.batchMode !== input.currentMode) {
    return false;
  }

  return input.batchMode === "local" || input.batchServerUrl === input.currentServerUrl;
}

export function getUploadAssetLabel(asset: UploadImageAsset): string {
  const fileName = asset.fileName?.trim();

  if (fileName) {
    return fileName;
  }

  return asset.uri.split("/").filter(Boolean).at(-1) ?? asset.uri;
}

export function getUploadFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return "处理失败，请稍后重试。";
}
