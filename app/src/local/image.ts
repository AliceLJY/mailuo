import { File as ExpoFile } from "expo-file-system";

import type { UploadImageAsset } from "../types";
import type { LoadedScreenshotImage } from "./types";

const MIME_BY_EXTENSION: Record<string, string> = {
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function resolveMimeType(asset: UploadImageAsset): string {
  const configured = asset.mimeType?.trim().toLowerCase();

  if (configured?.startsWith("image/")) {
    return configured === "image/jpg" ? "image/jpeg" : configured;
  }

  const path = asset.uri.split("?")[0] ?? asset.uri;
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const inferred = MIME_BY_EXTENSION[extension];

  if (!inferred) {
    throw new TypeError("无法识别截图格式，请选择 JPG、PNG、WebP、HEIC、BMP 或 GIF 图片。");
  }

  return inferred;
}

export async function loadScreenshotImage(asset: UploadImageAsset): Promise<LoadedScreenshotImage> {
  // simplified: local mode reads the selected asset directly and keeps its URI for review display.
  return {
    image: {
      base64: await new ExpoFile(asset.uri).base64(),
      mimeType: resolveMimeType(asset),
    },
    imagePath: asset.uri,
  };
}
