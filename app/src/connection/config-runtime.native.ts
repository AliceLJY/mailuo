import AsyncStorage from "expo-sqlite/kv-store";

import { createConnectionConfigStore } from "./config";

export const connectionConfigStore = createConnectionConfigStore(AsyncStorage);
