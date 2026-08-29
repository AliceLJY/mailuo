import type { ActionCardRecord } from "./types";

export const REVIEW_CARD_ORDER = {
  create_contact: 0,
  update_contact: 1,
  create_meeting: 2,
  record_interaction: 3,
} satisfies Record<ActionCardRecord["type"], number>;

export type ReviewCardGroup = {
  index: number;
  cards: ActionCardRecord[];
};

export function orderReviewCards(cards: ActionCardRecord[]) {
  return [...cards].sort((left, right) => {
    const leftRank = REVIEW_CARD_ORDER[left.type];
    const rightRank = REVIEW_CARD_ORDER[right.type];
    return leftRank === rightRank ? left.id - right.id : leftRank - rightRank;
  });
}

export function findCurrentPendingReviewCard(
  groups: ReviewCardGroup[],
  mode: "local" | "server" | null,
) {
  if (mode === "local") {
    return orderReviewCards(
      groups.flatMap((group) => group.cards).filter((card) => card.status === "pending"),
    )[0] ?? null;
  }

  for (const group of [...groups].sort((left, right) => left.index - right.index)) {
    const pending = orderReviewCards(group.cards).find((card) => card.status === "pending");
    if (pending) {
      return pending;
    }
  }

  return null;
}
