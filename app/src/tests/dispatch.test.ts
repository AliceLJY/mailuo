import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectionConfig, ConnectionConfigStore } from "../connection/config";
import {
  ApiTargetChangedError,
  createApiDispatcher,
  selectApiTarget,
  type RoutedApi,
} from "../connection/dispatch";

function configStore(config: ConnectionConfig | null): ConnectionConfigStore {
  return {
    async get() {
      return config;
    },
    async set() {},
    async clear() {},
  };
}

function fakeApi(label: string, calls: string[]): RoutedApi {
  return {
    async uploadScreenshot() {
      calls.push(label);
      return { screenshot_id: 1, cards: [] };
    },
    async confirmCard() {
      throw new Error("unused");
    },
    async rejectCard() {
      throw new Error("unused");
    },
    async getContacts() {
      calls.push(label);
      return [];
    },
    async getContactDetail() {
      throw new Error("unused");
    },
    async getMeetings() {
      calls.push(label);
      return [];
    },
    async getScreenshotDetail() {
      throw new Error("unused");
    },
  };
}

test("native local config dispatches to local API while web remains server-only", async () => {
  const calls: string[] = [];
  const store = configStore({ mode: "local" });
  const nativeApi = createApiDispatcher({
    configStore: store,
    platform: "ios",
    publicApiUrl: "https://env.example.test/",
    createServerApi: () => fakeApi("server", calls),
    async getLocalApi() {
      return fakeApi("local", calls);
    },
  });
  const webApi = createApiDispatcher({
    configStore: store,
    platform: "web",
    publicApiUrl: "https://env.example.test/",
    createServerApi: () => fakeApi("web-server", calls),
    async getLocalApi() {
      throw new Error("web must not load local API");
    },
  });

  await nativeApi.getContacts();
  await webApi.getMeetings();

  assert.deepEqual(calls, ["local", "web-server"]);
});

test("server config overrides env and missing config preserves the env server default", async () => {
  assert.deepEqual(
    await selectApiTarget({
      configStore: configStore({ mode: "server", serverUrl: "https://chosen.test///" }),
      platform: "android",
      publicApiUrl: "https://env.example.test/",
    }),
    { mode: "server", serverUrl: "https://chosen.test" },
  );
  assert.deepEqual(
    await selectApiTarget({
      configStore: configStore(null),
      platform: "android",
      publicApiUrl: "https://env.example.test/",
    }),
    { mode: "server", serverUrl: "https://env.example.test" },
  );
});

test("a batch-bound upload refuses to cross local and server storage", async () => {
  let config: ConnectionConfig = { mode: "local" };
  const calls: string[] = [];
  const store: ConnectionConfigStore = {
    async get() {
      return config;
    },
    async set(next) {
      config = next;
    },
    async clear() {},
  };
  const api = createApiDispatcher({
    configStore: store,
    platform: "ios",
    createServerApi: () => fakeApi("server", calls),
    async getLocalApi() {
      return fakeApi("local", calls);
    },
  });
  const asset = { uri: "file:///batch.png", mimeType: "image/png" };

  await api.uploadScreenshot({ asset, expectedTarget: { mode: "local" } });
  config = { mode: "server", serverUrl: "https://mailuo.example.test" };

  await assert.rejects(
    api.uploadScreenshot({ asset, expectedTarget: { mode: "local" } }),
    (error: unknown) => {
      assert.ok(error instanceof ApiTargetChangedError);
      assert.deepEqual(error.expectedTarget, { mode: "local" });
      assert.deepEqual(error.actualTarget, {
        mode: "server",
        serverUrl: "https://mailuo.example.test",
      });
      return true;
    },
  );
  assert.deepEqual(calls, ["local"]);
});

test("a batch-bound server upload refuses to switch server addresses", async () => {
  let config: ConnectionConfig = {
    mode: "server",
    serverUrl: "https://server-a.example.test/",
  };
  const calls: string[] = [];
  const store: ConnectionConfigStore = {
    async get() {
      return config;
    },
    async set(next) {
      config = next;
    },
    async clear() {},
  };
  const api = createApiDispatcher({
    configStore: store,
    platform: "ios",
    createServerApi: (serverUrl) => fakeApi(`server:${serverUrl}`, calls),
    async getLocalApi() {
      return fakeApi("local", calls);
    },
  });
  const asset = { uri: "file:///batch.png", mimeType: "image/png" };
  const expectedTarget = {
    mode: "server" as const,
    serverUrl: "https://server-a.example.test",
  };

  await api.uploadScreenshot({ asset, expectedTarget });
  config = { mode: "server", serverUrl: "https://server-b.example.test" };

  await assert.rejects(
    api.uploadScreenshot({ asset, expectedTarget }),
    ApiTargetChangedError,
  );
  assert.deepEqual(calls, ["server:https://server-a.example.test"]);
});
