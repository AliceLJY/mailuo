import * as SecureStore from "expo-secure-store";

import { createLocalLlmSecretStore } from "./secrets";

export const localLlmSecretStore = createLocalLlmSecretStore({
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
});
