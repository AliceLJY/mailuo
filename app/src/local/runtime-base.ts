// Native-only assembly; platform entry files keep it out of the Web bundle.
import { Platform } from "react-native";

import { getLocalProcessingSettings } from "../connection/config";
import { connectionConfigStore } from "../connection/config-runtime";
import { localLlmSecretStore } from "../connection/secure-store";
import type { RoutedApi } from "../connection/dispatch";

import { createLocalApi } from "./api";
import { loadScreenshotImage } from "./image";
import { buildOcrExportBundle } from "./ocr-export";
import {
  exportOcrBundleWithDirectoryPicker,
  readSourceMd5,
} from "./ocr-export.native";
import { perceiveScreenshotWithNativeOcr } from "./perceive-ocr.native";
import { perceiveOcrText } from "./perceive-text";
import { createExpoSqliteLocalStore } from "./store";

let localApi: RoutedApi | undefined;

export function getExpoLocalApi(): RoutedApi {
  if (!localApi) {
    localApi = createLocalApi({
      store: createExpoSqliteLocalStore(),
      keys: localLlmSecretStore,
      loadImage: loadScreenshotImage,
      async getProcessingSettings() {
        if (Platform.OS !== "android") {
          return { perceptionPath: "cloud", exportOcrResults: false };
        }

        return getLocalProcessingSettings(await connectionConfigStore.get());
      },
      perceiveOcr: perceiveScreenshotWithNativeOcr,
      perceiveOcrText,
      async exportOcr({ result, asset }) {
        const md5 = readSourceMd5(asset.uri);

        if (!md5) {
          throw new Error("无法读取原截图 MD5，OCR 诊断文件未导出。");
        }

        await exportOcrBundleWithDirectoryPicker(() => buildOcrExportBundle({
          result,
          exportedAt: new Date(),
          source: {
            name: asset.fileName,
            mimeType: asset.mimeType,
            width: asset.width,
            height: asset.height,
            md5,
          },
        }));
      },
    });
  }

  return localApi;
}
