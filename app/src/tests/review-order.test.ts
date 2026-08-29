import assert from "node:assert/strict";
import test from "node:test";

import {
  findCurrentPendingReviewCard,
  orderReviewCards,
  type ReviewCardGroup,
} from "../review-order";
import type { ActionCardRecord, ActionCardStatus, ActionCardType } from "../types";

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

test("local review globally prioritizes contact creation before dependent cards", () => {
  const groups: ReviewCardGroup[] = [
    {
      index: 0,
      cards: [
        card(10, 101, "create_meeting"),
        card(11, 101, "record_interaction"),
      ],
    },
    {
      index: 1,
      cards: [
        card(22, 102, "create_contact"),
        card(20, 102, "create_contact"),
      ],
    },
  ];

  assert.equal(findCurrentPendingReviewCard(groups, "local")?.id, 20);
});

test("server review preserves screenshot order while ordering within a screenshot", () => {
  const groups: ReviewCardGroup[] = [
    {
      index: 1,
      cards: [card(20, 102, "create_contact")],
    },
    {
      index: 0,
      cards: [
        card(12, 101, "record_interaction"),
        card(10, 101, "create_meeting"),
      ],
    },
  ];

  assert.equal(findCurrentPendingReviewCard(groups, "server")?.id, 10);
});

test("review ordering ignores resolved cards and uses database id as the tie breaker", () => {
  const cards = [
    card(30, 101, "create_contact"),
    card(8, 101, "create_contact", "confirmed"),
    card(10, 101, "create_contact"),
    card(2, 101, "update_contact"),
  ];

  assert.deepEqual(orderReviewCards(cards).map((item) => item.id), [8, 10, 30, 2]);
  assert.equal(
    findCurrentPendingReviewCard([{ index: 0, cards }], "local")?.id,
    10,
  );
});
