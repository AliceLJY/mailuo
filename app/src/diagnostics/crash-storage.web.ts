import type { SyncCrashStorage } from "./crash-record";

export const crashStorage: SyncCrashStorage = {
  getItemSync(key) {
    return globalThis.localStorage?.getItem(key) ?? null;
  },
  setItemSync(key, value) {
    globalThis.localStorage?.setItem(key, value);
  },
  removeItemSync(key) {
    const storage = globalThis.localStorage;
    if (!storage) {
      return false;
    }

    const existed = storage.getItem(key) !== null;
    storage.removeItem(key);
    return existed;
  },
};
