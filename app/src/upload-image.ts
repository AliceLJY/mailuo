import { Image, Platform } from "react-native";

import { File as ExpoFile } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type { ImageRef } from "expo-image-manipulator";

import type { UploadImageAsset } from "@/types";

const MAX_UPLOAD_EDGE = 1280;
const SCREENSHOT_JPEG_QUALITY = 0.8;

export type PreparedUploadAsset = {
  uri: string;
  fileName: string;
  mimeType: "image/jpeg";
  cleanup?: () => void;
};

export async function prepareScreenshotForUpload(
  asset: UploadImageAsset,
): Promise<PreparedUploadAsset> {
  const { width, height } = await resolveImageDimensions(asset);
  const context = ImageManipulator.manipulate(asset.uri);
  let image: ImageRef | null = null;

  try {
    if (Math.max(width, height) > MAX_UPLOAD_EDGE) {
      if (width >= height) {
        context.resize({ width: MAX_UPLOAD_EDGE });
      } else {
        context.resize({ height: MAX_UPLOAD_EDGE });
      }
    }

    image = await context.renderAsync();

    const result = await image.saveAsync({
      compress: SCREENSHOT_JPEG_QUALITY,
      format: SaveFormat.JPEG,
    });

    return {
      uri: result.uri,
      fileName: toJpegFileName(asset),
      mimeType: "image/jpeg",
      cleanup: createPreparedAssetCleanup(result.uri),
    };
  } finally {
    image?.release();
    context.release();
  }
}

function resolveImageDimensions(asset: UploadImageAsset) {
  if (isPositiveNumber(asset.width) && isPositiveNumber(asset.height)) {
    return Promise.resolve({ width: asset.width, height: asset.height });
  }

  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    Image.getSize(
      asset.uri,
      (width, height) => resolve({ width, height }),
      (error) => reject(new Error(`读取图片尺寸失败：${error.message}`)),
    );
  });
}

function toJpegFileName(asset: UploadImageAsset) {
  const rawName =
    asset.fileName?.trim() ||
    asset.uri.split("?")[0]?.split("/").filter(Boolean).at(-1) ||
    `screenshot-${Date.now()}`;
  const baseName = rawName.replace(/\.[^./]+$/u, "");

  return `${baseName || `screenshot-${Date.now()}`}.jpg`;
}

function createWebObjectUrlCleanup(uri: string) {
  if (
    Platform.OS !== "web" ||
    !uri.startsWith("blob:") ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    return undefined;
  }

  return () => {
    URL.revokeObjectURL(uri);
  };
}

function createNativeFileCleanup(uri: string) {
  if (Platform.OS === "web" || !uri.startsWith("file:")) {
    return undefined;
  }

  return () => {
    new ExpoFile(uri).delete();
  };
}

function createPreparedAssetCleanup(uri: string) {
  return createWebObjectUrlCleanup(uri) ?? createNativeFileCleanup(uri);
}

function isPositiveNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
