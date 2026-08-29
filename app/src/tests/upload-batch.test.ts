import assert from "node:assert/strict";
import { setImmediate as waitForNextTurn } from "node:timers/promises";
import test from "node:test";

import type { ConnectionConfigStore } from "../connection/config";
import { createApiDispatcher, type RoutedApi } from "../connection/dispatch";
import type {
  ActionCardRecord,
  ScreenshotUploadResponse,
  UploadImageAsset,
} from "../types";
import {
  getFailedUploadAssets,
  getFailedUploadItems,
  mergeUploadBatchResults,
  uploadScreenshotBatch,
  type UploadBatchSuccessItem,
} from "../upload-batch";

function asset(index: number): UploadImageAsset {
  return {
    uri: `file:///screenshot-${index}.png`,
    fileName: `screenshot-${index}.png`,
    mimeType: "image/png",
  };
}

function createContactCard(
  id: number,
  screenshotId: number,
  sourceQuote: string,
): ActionCardRecord {
  return {
    id,
    screenshot_id: screenshotId,
    type: "create_contact",
    payload: { name: "张三" },
    confidence: "high",
    source_quote: sourceQuote,
    disambiguation: null,
    status: "pending",
    created_at: "2026-08-29T08:00:00+08:00",
    resolved_contact_id: null,
    resolved_at: null,
  };
}

function emptyResponse(screenshotId: number): ScreenshotUploadResponse {
  return { screenshot_id: screenshotId, cards: [] };
}

function apiWithUpload(
  upload: RoutedApi["uploadScreenshot"],
): RoutedApi {
  return {
    uploadScreenshot: upload,
    async uploadText() {
      throw new Error("unused");
    },
    async confirmCard() {
      throw new Error("unused");
    },
    async rejectCard() {
      throw new Error("unused");
    },
    async getContacts() {
      throw new Error("unused");
    },
    async getContactDetail() {
      throw new Error("unused");
    },
    async getMeetings() {
      throw new Error("unused");
    },
    async getScreenshotDetail() {
      throw new Error("unused");
    },
  };
}

test("server batch uploads both screenshots and preserves each response without merging", async () => {
  const assets = [asset(1), asset(2)];
  const responses: ScreenshotUploadResponse[] = [
    {
      screenshot_id: 101,
      cards: [createContactCard(1001, 101, "第一张截图里的证据")],
    },
    {
      screenshot_id: 102,
      cards: [createContactCard(1002, 102, "第二张截图里的证据")],
    },
  ];
  const serverInputs: Parameters<RoutedApi["uploadScreenshot"]>[0][] = [];
  const configStore: ConnectionConfigStore = {
    async get() {
      return { mode: "server", serverUrl: "https://mailuo.example.test/" };
    },
    async set() {},
    async clear() {},
  };
  let responseIndex = 0;
  const api = createApiDispatcher({
    configStore,
    platform: "ios",
    createServerApi(serverUrl) {
      assert.equal(serverUrl, "https://mailuo.example.test");
      return apiWithUpload(async (input) => {
        serverInputs.push(input);
        const response = responses[responseIndex];
        responseIndex += 1;
        return response;
      });
    },
    async getLocalApi() {
      throw new Error("server batch must not load the local API");
    },
  });

  const result = await uploadScreenshotBatch({
    assets,
    mode: "server",
    serverUrl: "https://mailuo.example.test/",
    note: "整批共用说明",
    async uploadScreenshot({ asset: currentAsset, note: currentNote }) {
      return api.uploadScreenshot({ asset: currentAsset, note: currentNote });
    },
  });

  assert.deepEqual(serverInputs.map((input) => `${input.asset.fileName}:${input.note}`), [
    "screenshot-1.png:整批共用说明",
    "screenshot-2.png:整批共用说明",
  ]);
  assert.ok(serverInputs.every((input) => !("localBatch" in input)));
  assert.equal(result.mode, "server");
  assert.equal(result.serverUrl, "https://mailuo.example.test");
  assert.equal(result.status, "success");
  assert.deepEqual(
    result.items.map((item) => item.status),
    ["success", "success"],
  );
  const successful = result.items as UploadBatchSuccessItem[];
  assert.deepEqual(
    successful.map((item) => item.response),
    responses,
  );
  assert.deepEqual(
    successful.flatMap((item) => item.response.cards.map((card) => ({
      screenshotId: card.screenshot_id,
      sourceQuote: card.source_quote,
    }))),
    [
      { screenshotId: 101, sourceQuote: "第一张截图里的证据" },
      { screenshotId: 102, sourceQuote: "第二张截图里的证据" },
    ],
  );
  assert.equal(successful.flatMap((item) => item.response.cards).length, 2);
});

test("batch continues after a middle failure and never overlaps uploads", async () => {
  const assets = [asset(1), asset(2), asset(3)];
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;

  const result = await uploadScreenshotBatch({
    assets,
    mode: "local",
    async uploadScreenshot({ asset: currentAsset }) {
      const label = currentAsset.fileName!;
      events.push(`start:${label}`);
      active += 1;
      maxActive = Math.max(maxActive, active);

      try {
        await waitForNextTurn();

        if (label === "screenshot-2.png") {
          events.push(`error:${label}`);
          throw new Error("模型暂时不可用");
        }

        events.push(`success:${label}`);
        return emptyResponse(Number(label.match(/\d+/u)?.[0]));
      } finally {
        active -= 1;
      }
    },
  });

  assert.deepEqual(events, [
    "start:screenshot-1.png",
    "success:screenshot-1.png",
    "start:screenshot-2.png",
    "error:screenshot-2.png",
    "start:screenshot-3.png",
    "success:screenshot-3.png",
  ]);
  assert.equal(maxActive, 1);
  assert.equal(result.status, "partial_success");
  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 1);
  assert.deepEqual(
    result.items.map((item) => item.status),
    ["success", "failure", "success"],
  );
  assert.deepEqual(result.items[1], {
    asset: assets[1],
    fileName: "screenshot-2.png",
    index: 1,
    status: "failure",
    reason: "模型暂时不可用",
  });
  assert.deepEqual(getFailedUploadAssets(result), [assets[1]]);

  const failedItems = getFailedUploadItems(result);
  const retryCalls: Array<{ fileName: string; index: number }> = [];
  const retry = await uploadScreenshotBatch({
    items: failedItems,
    mode: "local",
    async uploadScreenshot({ asset: failedAsset, index }) {
      retryCalls.push({ fileName: failedAsset.fileName!, index });
      return emptyResponse(22);
    },
  });

  assert.deepEqual(retryCalls, [{ fileName: "screenshot-2.png", index: 1 }]);
  assert.equal(retry.items[0].index, 1);
  assert.equal(retry.items[0].asset, assets[1]);
  assert.equal(retry.status, "success");

  const merged = mergeUploadBatchResults(result, retry);
  assert.equal(merged.status, "success");
  assert.equal(merged.successCount, 3);
  assert.equal(merged.failureCount, 0);
  assert.deepEqual(
    merged.items.map((item) => item.index),
    [0, 1, 2],
  );
});

test("batch is failed only when every upload fails", async () => {
  const assets = [asset(1), asset(2)];

  const result = await uploadScreenshotBatch({
    assets,
    mode: "server",
    async uploadScreenshot({ asset: currentAsset }) {
      throw `无法处理 ${currentAsset.fileName}`;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.successCount, 0);
  assert.equal(result.failureCount, 2);
  assert.deepEqual(
    result.items.map((item) => item.status),
    ["failure", "failure"],
  );
  assert.deepEqual(getFailedUploadAssets(result), assets);
});

test("batch cancellation stops before invoking the next screenshot", async () => {
  const assets = [asset(1), asset(2), asset(3)];
  const calls: string[] = [];
  const progress: string[] = [];
  let shouldContinue = true;

  const result = await uploadScreenshotBatch({
    assets,
    mode: "server",
    shouldContinue: () => shouldContinue,
    async uploadScreenshot({ asset: currentAsset }) {
      calls.push(currentAsset.fileName!);
      shouldContinue = false;
      return emptyResponse(1);
    },
    onProgress(item) {
      progress.push(`${item.status}:${item.index}`);
    },
  });

  assert.deepEqual(calls, ["screenshot-1.png"]);
  assert.deepEqual(progress, ["processing:0"]);
  assert.deepEqual(result.items, []);
});
