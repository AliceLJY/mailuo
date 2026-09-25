import assert from "node:assert/strict";
import test from "node:test";

import {
  applyScreenshotDetailToItems,
  applyUploadResponseCards,
  applyUploadResponseSources,
  applyUploadResponseToItems,
  findFlowItemForScreenshot,
  getCardSourceLabels,
  hasPendingFlowCards,
  type FlowBatchItem,
} from "../flow-context";
import type {
  ActionCardRecord,
  ActionCardStatus,
  ScreenshotDetail,
  ScreenshotUploadResponse,
} from "../types";
import {
  getDuplicateUploadItems,
  getUploadReviewScreenshotId,
  type UploadBatchResult,
} from "../upload-batch";

const duplicateNotice = "这张截图之前上传过，没有重复处理，已为你显示上次的结果。";

function contactCard(
  id: number,
  screenshotId: number,
  status: ActionCardStatus = "pending",
): ActionCardRecord {
  return {
    id,
    screenshot_id: screenshotId,
    type: "create_contact",
    payload: { name: `示例联系人 ${id}` },
    confidence: "high",
    source_quote: `示例证据 ${id}`,
    disambiguation: null,
    status,
    created_at: "2026-09-01T08:00:00+08:00",
    resolved_contact_id: null,
    resolved_at: status === "pending" ? null : "2026-09-01T08:05:00+08:00",
  };
}

function pendingItem(index: number): FlowBatchItem {
  const label = `synthetic-${index + 1}.png`;

  return {
    index,
    asset: { uri: `file:///${label}`, fileName: label },
    label,
    status: "pending",
    screenshotId: null,
    cards: [],
    detail: null,
    processingNotice: null,
    duplicateOfScreenshotId: null,
    error: null,
  };
}

// What the server answers for a byte-identical re-upload: the earlier screenshot's current cards.
function duplicateResponse(earlierScreenshotId: number): ScreenshotUploadResponse {
  return {
    screenshot_id: earlierScreenshotId,
    cards: [
      contactCard(earlierScreenshotId * 10, earlierScreenshotId, "confirmed"),
      contactCard(earlierScreenshotId * 10 + 1, earlierScreenshotId),
    ],
    duplicate_of_screenshot_id: earlierScreenshotId,
    processing_notice: duplicateNotice,
  };
}

function earlierDetail(response: ScreenshotUploadResponse): ScreenshotDetail {
  return {
    id: response.screenshot_id,
    image_path: `/srv/mailuo/screenshots/earlier-${response.screenshot_id}.png`,
    user_note: null,
    raw_extraction: null,
    uploaded_at: "2026-09-01T08:00:00+08:00",
    cards: response.cards,
  };
}

function applyResponses(responses: ScreenshotUploadResponse[]) {
  let items = responses.map((_response, index) => pendingItem(index));
  let cards: ActionCardRecord[] = [];
  let sources: Record<number, number[]> = {};

  responses.forEach((response, index) => {
    items = applyUploadResponseToItems(items, index, response);
    cards = applyUploadResponseCards(cards, response);
    sources = applyUploadResponseSources(sources, response);
  });

  return { items, cards, sources };
}

function batchResult(responses: ScreenshotUploadResponse[]): UploadBatchResult {
  return {
    mode: "server",
    serverUrl: "https://mailuo.example.test",
    status: "success",
    totalCount: responses.length,
    successCount: responses.length,
    failureCount: 0,
    items: responses.map((response, index) => ({
      asset: pendingItem(index).asset!,
      fileName: pendingItem(index).label,
      index,
      status: "success",
      response,
    })),
  };
}

test("a duplicate response adds no pending cards to the batch and keeps its notice", () => {
  const response = duplicateResponse(55);
  const { items, cards, sources } = applyResponses([response]);

  assert.deepEqual(items[0], {
    ...pendingItem(0),
    status: "success",
    screenshotId: null,
    cards: [],
    processingNotice: duplicateNotice,
    duplicateOfScreenshotId: 55,
  });
  assert.deepEqual(cards, []);
  assert.equal(hasPendingFlowCards(cards), false);
  assert.deepEqual(sources, {});
});

test("a single re-uploaded image opens the earlier screenshot's detail", () => {
  const response = duplicateResponse(55);
  const { items } = applyResponses([response]);

  assert.equal(getUploadReviewScreenshotId(batchResult([response])), 55);
  assert.equal(findFlowItemForScreenshot(items, 55), items[0]);

  // The review route for 55 loads getScreenshotDetail(55) into the marked item.
  const detail = earlierDetail(response);
  const opened = applyScreenshotDetailToItems(items, detail);

  assert.ok(opened);
  assert.deepEqual(opened[0], {
    ...items[0],
    screenshotId: 55,
    cards: detail.cards,
    detail,
  });
  assert.deepEqual(
    opened[0].cards.map((card) => card.status),
    ["confirmed", "pending"],
  );
  assert.equal(opened[0].processingNotice, duplicateNotice);
  assert.equal(findFlowItemForScreenshot(opened, 55), opened[0]);
});

test("in a larger batch only the re-uploaded image is marked and the others are reviewed as usual", () => {
  const first: ScreenshotUploadResponse = {
    screenshot_id: 101,
    cards: [contactCard(1011, 101), contactCard(1010, 101)],
  };
  const duplicate = duplicateResponse(55);
  const third: ScreenshotUploadResponse = {
    screenshot_id: 103,
    cards: [contactCard(1030, 103)],
  };
  const { items, cards, sources } = applyResponses([first, duplicate, third]);

  assert.deepEqual(
    items.map((item) => [item.screenshotId, item.duplicateOfScreenshotId, item.processingNotice]),
    [
      [101, null, null],
      [null, 55, duplicateNotice],
      [103, null, null],
    ],
  );
  assert.deepEqual(items[0].cards.map((card) => card.id), [1010, 1011]);
  assert.deepEqual(items[1].cards, []);
  assert.deepEqual(cards.map((card) => card.id), [1010, 1011, 1030]);
  assert.deepEqual(Object.keys(sources).map(Number).sort(), [1010, 1011, 1030]);
  assert.deepEqual(getCardSourceLabels(items, sources), {
    1010: ["synthetic-1.png"],
    1011: ["synthetic-1.png"],
    1030: ["synthetic-3.png"],
  });

  const result = batchResult([first, duplicate, third]);
  assert.equal(getUploadReviewScreenshotId(result), 101);
  assert.deepEqual(getDuplicateUploadItems(result).map((item) => item.index), [1]);

  // Tapping the marked image loads the earlier screenshot into that item alone.
  const opened = applyScreenshotDetailToItems(items, earlierDetail(duplicate));
  assert.ok(opened);
  assert.equal(opened[0], items[0]);
  assert.equal(opened[2], items[2]);
  assert.equal(opened[1].screenshotId, 55);
  assert.deepEqual(opened[1].cards.map((card) => card.id), [550, 551]);

  // A batch where every image was uploaded before opens nothing by itself; each stays marked.
  const allDuplicates = batchResult([duplicateResponse(55), duplicateResponse(56)]);
  assert.equal(getUploadReviewScreenshotId(allDuplicates), null);
  assert.deepEqual(getDuplicateUploadItems(allDuplicates).map((item) => item.index), [0, 1]);
});

test("an image picked twice in one batch keeps the second copy pointing at the first", () => {
  const first: ScreenshotUploadResponse = {
    screenshot_id: 101,
    cards: [contactCard(1010, 101)],
  };
  const secondCopy: ScreenshotUploadResponse = {
    ...duplicateResponse(101),
    cards: first.cards,
  };
  const { items, cards } = applyResponses([first, secondCopy]);

  assert.deepEqual(cards.map((card) => card.id), [1010]);
  assert.equal(findFlowItemForScreenshot(items, 101), items[0]);

  const refreshed = applyScreenshotDetailToItems(items, earlierDetail(first));
  assert.ok(refreshed);
  assert.equal(refreshed[1], items[1]);
  assert.equal(refreshed[1].screenshotId, null);
});

test("responses without duplicate_of_screenshot_id are applied exactly as before", () => {
  const anchor = contactCard(1000, 100);
  const response: ScreenshotUploadResponse = {
    screenshot_id: 101,
    cards: [contactCard(1011, 101), contactCard(1010, 101)],
    processing_notice: "部分文字识别不清，已改用视觉模型。",
    local_batch_contact_merges: [
      {
        anchor_card: { ...anchor, source_quote: "示例证据 1000\n\n示例证据 1011" },
        evidence: [{ screenshot_id: 101, source_quotes: ["示例证据 1011"] }],
      },
    ],
  };
  const earlierItems = [
    { ...pendingItem(0), status: "success" as const, screenshotId: 100, cards: [anchor] },
    pendingItem(1),
  ];

  const items = applyUploadResponseToItems(earlierItems, 1, response);
  assert.deepEqual(items[1], {
    ...pendingItem(1),
    status: "success",
    screenshotId: 101,
    cards: [response.cards[1], response.cards[0]],
    processingNotice: "部分文字识别不清，已改用视觉模型。",
  });
  assert.equal(items[0].cards[0].source_quote, "示例证据 1000\n\n示例证据 1011");
  assert.deepEqual(
    applyUploadResponseCards([anchor], response).map((card) => card.id),
    [1000, 1010, 1011],
  );
  assert.deepEqual(applyUploadResponseSources({ 1000: [100] }, response), {
    1000: [100, 101],
    1010: [101],
    1011: [101],
  });

  const result = batchResult([{ screenshot_id: 100, cards: [anchor] }, response]);
  assert.equal(getUploadReviewScreenshotId(result), 100);
  assert.deepEqual(getDuplicateUploadItems(result), []);
  assert.equal(
    getUploadReviewScreenshotId({
      ...result,
      status: "failed",
      totalCount: 1,
      successCount: 0,
      failureCount: 1,
      items: [
        {
          asset: pendingItem(0).asset!,
          fileName: "synthetic-1.png",
          index: 0,
          status: "failure",
          reason: "处理失败，请稍后重试。",
        },
      ],
    }),
    null,
  );

  const detail: ScreenshotDetail = {
    ...earlierDetail({ screenshot_id: 101, cards: [] }),
    cards: [contactCard(1010, 101, "confirmed"), contactCard(1011, 101)],
  };
  const refreshed = applyScreenshotDetailToItems(items, detail);
  assert.ok(refreshed);
  assert.deepEqual(refreshed[1], { ...items[1], cards: detail.cards, detail });
  assert.equal(refreshed[0], items[0]);
  assert.equal(applyScreenshotDetailToItems(items, { ...detail, id: 999 }), null);
});
