// Native-only assembly; platform entry files keep it out of the Web bundle.
import { localLlmSecretStore } from "../connection/secure-store";
import type { RoutedApi } from "../connection/dispatch";

import { createLocalApi } from "./api";
import { loadScreenshotImage } from "./image";
import { createExpoSqliteLocalStore } from "./store";

let localApi: RoutedApi | undefined;

export function getExpoLocalApi(): RoutedApi {
  if (!localApi) {
    localApi = createLocalApi({
      store: createExpoSqliteLocalStore(),
      keys: localLlmSecretStore,
      loadImage: loadScreenshotImage,
    });
  }

  return localApi;
}
