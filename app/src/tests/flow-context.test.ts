import assert from "node:assert/strict";
import test from "node:test";

import {
  applyConfirmInsightsToFlow,
  applyInsightRetryResultToFlow,
  applyUploadResponseSources,
  applyUploadResponseToItems,
  createFlowItemFromScreenshotDetail,
  createPendingPastedTextItem,
  findCompletedPastedTextItem,
  getCardSourceLabels,
  hasInProgressFlowItems,
  hasPendingFlowCards,
  isPastedTextSourcePath,
  shouldPreserveBatchOnReset,
  type FlowBatchItem,
} from "../flow-context";
import type {
  ActionCardRecord,
  ConfirmCardResponse,
  InsightRecord,
  ScreenshotDetail,
  ScreenshotUploadResponse,
} from "../types";

function createContactCard(
  id: number,
  screenshotId: number,
  title?: string,
): ActionCardRecord {
  return {
    id,
    screenshot_id: screenshotId,
    type: "create_contact",
    payload: { name: "张三", ...(title ? { title } : {}) },
    confidence: "high",
    source_quote: title ? "第一张证据\n\n第三张证据" : "第一张证据",
    disambiguation: null,
    status: "pending",
    created_at: "2026-08-29T08:00:00+08:00",
    resolved_contact_id: null,
    resolved_at: null,
  };
}

function batchItem(
  index: number,
  screenshotId: number,
  label: string,
  cards: ActionCardRecord[],
): FlowBatchItem {
  return {
    index,
    asset: { uri: `file:///${label}`, fileName: label },
    label,
    status: "success",
    screenshotId,
    cards,
    detail: null,
    processingNotice: null,
    duplicateOf: null,
    error: null,
  };
}

test("connection changes preserve both active and completed batch results", () => {
  const pendingTextItem = createPendingPastedTextItem();
  assert.equal(pendingTextItem.asset, null);
  assert.equal(pendingTextItem.label, "粘贴文本");
  assert.equal(hasInProgressFlowItems([pendingTextItem]), true);
  assert.equal(hasInProgressFlowItems([{ status: "success" }]), false);
  assert.equal(
    shouldPreserveBatchOnReset([pendingTextItem], false, {
      preserveExistingBatch: true,
    }),
    true,
  );
  assert.equal(
    shouldPreserveBatchOnReset([{ status: "processing" }], false),
    true,
  );
  assert.equal(
    shouldPreserveBatchOnReset(
      [{ status: "success" }, { status: "failure" }],
      true,
      { preserveExistingBatch: true },
    ),
    true,
  );
  assert.equal(
    shouldPreserveBatchOnReset([], false, { preserveExistingBatch: true }),
    false,
  );
  assert.equal(
    shouldPreserveBatchOnReset([{ status: "success" }], true),
    false,
  );
});

test("the upload page only offers review while this batch still has pending cards", () => {
  assert.equal(
    hasPendingFlowCards([
      { status: "confirmed" },
      { status: "rejected" },
    ]),
    false,
  );
  assert.equal(
    hasPendingFlowCards([
      { status: "confirmed" },
      { status: "pending" },
    ]),
    true,
  );
});

test("a completed pasted-text flow remains discoverable after the upload page loses focus", () => {
  const detail: ScreenshotDetail = {
    id: 201,
    image_path: "data:text/plain;charset=utf-8,%E6%98%8E%E5%A4%A99%3A30%E5%BC%80%E4%BC%9A",
    user_note: "群通知",
    raw_extraction: null,
    uploaded_at: "2026-08-29T08:00:00+08:00",
    cards: [createContactCard(20, 201)],
  };

  assert.equal(isPastedTextSourcePath(detail.image_path), true);
  const item = createFlowItemFromScreenshotDetail(detail);

  assert.equal(item.asset, null);
  assert.equal(item.label, "粘贴文本");
  assert.equal(item.screenshotId, 201);
  assert.equal(findCompletedPastedTextItem([item]), item);
});

test("a merged contact stays in its anchor screenshot group and lists every evidence source", () => {
  const anchor = createContactCard(10, 101);
  const updatedAnchor = createContactCard(10, 101, "产品总监");
  const items = [
    batchItem(0, 101, "first.png", [anchor]),
    batchItem(1, 102, "second.png", []),
    batchItem(2, 103, "third.png", []),
  ];
  const response: ScreenshotUploadResponse = {
    screenshot_id: 103,
    cards: [],
    local_batch_contact_merges: [
      {
        anchor_card: updatedAnchor,
        evidence: [
          { screenshot_id: 101, source_quotes: ["第一张证据"] },
          { screenshot_id: 103, source_quotes: ["第三张证据"] },
        ],
      },
    ],
  };

  const nextItems = applyUploadResponseToItems(items, 2, response);
  const sources = applyUploadResponseSources({}, response);
  const sourceLabels = getCardSourceLabels(nextItems, sources);
  const mergedAnchor = nextItems[0].cards[0];

  assert.equal(mergedAnchor?.type, "create_contact");
  if (!mergedAnchor || mergedAnchor.type !== "create_contact") {
    assert.fail("expected the merged anchor to remain a create_contact card");
  }
  assert.equal(mergedAnchor.payload.title, "产品总监");
  assert.deepEqual(nextItems.slice(1).flatMap((item) => item.cards), []);
  assert.deepEqual(sourceLabels[anchor.id], ["first.png", "third.png"]);
});

function insight(id: number, contactId: number, content: string): InsightRecord {
  return {
    id,
    contact_id: contactId,
    kind: "suggested_action",
    content,
    based_on: [id * 10],
    generated_at: "2026-09-01T08:00:00+08:00",
  };
}

test("a successful insight retry merges new insights by id and clears the failure notice", () => {
  const state = {
    insights: [insight(1, 5, "已有的洞察"), insight(2, 6, "旧版本的洞察")],
    hasInsightFailure: true,
  };

  const next = applyInsightRetryResultToFlow(
    state,
    {
      insight_status: "ok",
      insights: [insight(2, 6, "重新生成后的洞察"), insight(3, 7, "新的洞察")],
    },
    true,
  );

  assert.equal(next.hasInsightFailure, false);
  assert.deepEqual(
    next.insights.map((item) => [item.id, item.content]),
    [
      [2, "重新生成后的洞察"],
      [3, "新的洞察"],
      [1, "已有的洞察"],
    ],
  );
});

test("a failed insight retry keeps the failure notice and the insights already shown", () => {
  const state = {
    insights: [insight(1, 5, "已有的洞察")],
    hasInsightFailure: true,
  };

  const next = applyInsightRetryResultToFlow(
    state,
    { insight_status: "failed", insight_error: "模型暂时不可用", insights: [] },
    true,
  );

  assert.equal(next, state);
  assert.equal(next.hasInsightFailure, true);
});

test("an insight retry result that returns after the flow moved on is dropped", () => {
  // A new batch or another screenshot replaced the flow while the retry was running.
  const newFlow = { insights: [], hasInsightFailure: false };

  assert.equal(
    applyInsightRetryResultToFlow(
      newFlow,
      { insight_status: "ok", insights: [insight(3, 7, "上一个流程的洞察")] },
      false,
    ),
    newFlow,
  );
  assert.equal(
    applyInsightRetryResultToFlow(
      { insights: [], hasInsightFailure: true },
      { insight_status: "ok", insights: [insight(3, 7, "上一个流程的洞察")] },
      false,
    ).hasInsightFailure,
    true,
  );
});

test("confirm results merge insights the same way and keep a failure flagged until a retry", () => {
  const confirmResult = (
    status: ConfirmCardResponse["insight_status"],
    insights: InsightRecord[],
  ): ConfirmCardResponse => ({
    executed: true,
    card: createContactCard(40, 301),
    affected_contact_ids: [5],
    observation_ids: [50],
    insight_status: status,
    insights,
  });

  const failed = applyConfirmInsightsToFlow(
    { insights: [insight(1, 5, "已有的洞察")], hasInsightFailure: false },
    confirmResult("failed", []),
  );
  const laterOk = applyConfirmInsightsToFlow(
    failed,
    confirmResult("ok", [insight(1, 5, "更新后的洞察"), insight(2, 6, "新的洞察")]),
  );

  assert.equal(failed.hasInsightFailure, true);
  assert.equal(laterOk.hasInsightFailure, true);
  assert.deepEqual(
    laterOk.insights.map((item) => [item.id, item.content]),
    [
      [1, "更新后的洞察"],
      [2, "新的洞察"],
    ],
  );
  assert.equal(
    applyInsightRetryResultToFlow(laterOk, { insight_status: "ok", insights: [] }, true)
      .hasInsightFailure,
    false,
  );
});
