import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrderedReviewGroups,
  findCurrentPendingReviewCard,
  orderReviewCardSequence,
  orderReviewCards,
  type ReviewCardGroup,
} from "../review-order";
import { applyUploadResponseToItems, type FlowBatchItem } from "../flow-context";
import type {
  ActionCardRecord,
  ActionCardStatus,
  ActionCardType,
  ScreenshotUploadResponse,
} from "../types";

function card(
  id: number,
  screenshotId: number,
  type: ActionCardType,
  status: ActionCardStatus = "pending",
): ActionCardRecord {
  return {
    id,
    screenshot_id: screenshotId,
    type,
    payload: { name: `联系人 ${id}` },
    confidence: "high",
    source_quote: `证据 ${id}`,
    disambiguation: null,
    status,
    created_at: "2026-08-29T08:00:00+08:00",
    resolved_contact_id: null,
    resolved_at: null,
  } as ActionCardRecord;
}

function threeScreenshotGroups(): ReviewCardGroup[] {
  return [
    {
      index: 2,
      cards: [
        card(31, 103, "update_contact"),
        card(30, 103, "create_meeting"),
      ],
    },
    {
      index: 0,
      cards: [
        card(12, 101, "record_interaction"),
        card(10, 101, "create_meeting"),
        card(11, 101, "create_contact"),
      ],
    },
    {
      index: 1,
      cards: [
        card(21, 102, "create_meeting"),
        card(20, 102, "record_interaction"),
      ],
    },
  ];
}

function pendingFlowItem(index: number): FlowBatchItem {
  const label = `screenshot-${index + 1}.png`;

  return {
    index,
    asset: { uri: `file:///${label}`, fileName: label },
    label,
    status: "pending",
    screenshotId: null,
    cards: [],
    detail: null,
    processingNotice: null,
    error: null,
  };
}

function applyFlowResponses(
  responses: ScreenshotUploadResponse[],
) {
  return responses.reduce(
    (items, response, index) => applyUploadResponseToItems(items, index, response),
    [pendingFlowItem(0), pendingFlowItem(1), pendingFlowItem(2)],
  );
}

function selectReviewSequence(items: FlowBatchItem[]) {
  const latestCards = items.flatMap((item) => item.cards);
  return buildOrderedReviewGroups(items, latestCards)
    .flatMap((group) => group.cards)
    .map((item) => item.id);
}

test("review sequence keeps every screenshot together and uses natural card id order", () => {
  assert.deepEqual(
    orderReviewCardSequence(threeScreenshotGroups()).map((item) => item.id),
    [10, 11, 12, 20, 21, 30, 31],
  );
});

test("local and server review use the same screenshot and card sequence", () => {
  const firstResponse: ScreenshotUploadResponse = {
    screenshot_id: 101,
    cards: [
      card(12, 101, "record_interaction"),
      card(10, 101, "create_meeting"),
      card(11, 101, "create_contact"),
    ],
  };
  const secondResponse: ScreenshotUploadResponse = {
    screenshot_id: 102,
    cards: [
      card(21, 102, "create_meeting"),
      card(20, 102, "record_interaction"),
    ],
  };
  const thirdResponse: ScreenshotUploadResponse = {
    screenshot_id: 103,
    cards: [
      card(31, 103, "update_contact"),
      card(30, 103, "create_meeting"),
    ],
  };
  const serverItems = applyFlowResponses([
    firstResponse,
    secondResponse,
    thirdResponse,
  ]);
  const localItems = applyFlowResponses([
    firstResponse,
    secondResponse,
    {
      ...thirdResponse,
      local_batch_contact_merges: [
        {
          anchor_card: card(11, 101, "create_contact"),
          evidence: [
            { screenshot_id: 101, source_quotes: ["证据 11"] },
            { screenshot_id: 103, source_quotes: ["证据 31"] },
          ],
        },
      ],
    },
  ]);

  const localSequence = selectReviewSequence(localItems);
  const serverSequence = selectReviewSequence(serverItems);

  assert.deepEqual(localSequence, [10, 11, 12, 20, 21, 30, 31]);
  assert.deepEqual(serverSequence, localSequence);
  assert.equal(localItems[0].cards.some((item) => item.id === 11), true);
  assert.equal(localItems[2].cards.some((item) => item.id === 11), false);
});

test("current review card is the first pending card in group and id order", () => {
  const groups = threeScreenshotGroups();
  groups[1].cards = groups[1].cards.map((item) =>
    item.id === 10 ? { ...item, status: "confirmed" } : item,
  );

  assert.deepEqual(orderReviewCards(groups[1].cards).map((item) => item.id), [10, 11, 12]);
  assert.equal(findCurrentPendingReviewCard(groups)?.id, 11);
});
