import { Storage } from "expo-sqlite/kv-store";

import type { SyncCrashStorage } from "./crash-record";

export const crashStorage: SyncCrashStorage = Storage;
