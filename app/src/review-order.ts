import type {
  ActionCardRecord,
  ActionCardStatus,
} from "./types";

export type ReviewCardStage = "current" | "upcoming" | "done";

export type ReviewCardGroup = {
  index: number;
  cards: ActionCardRecord[];
};

export function buildOrderedReviewGroups<T extends ReviewCardGroup>(
  items: T[],
  latestCards: ActionCardRecord[],
) {
  const latestCardById = new Map(latestCards.map((card) => [card.id, card]));

  return [...items]
    .sort((left, right) => left.index - right.index)
    .map((item) => ({
      item,
      cards: orderReviewCards(
        item.cards.map((card) => latestCardById.get(card.id) ?? card),
      ),
    }));
}

export function orderReviewCards(cards: ActionCardRecord[]) {
  return [...cards].sort((left, right) => left.id - right.id);
}

export function orderReviewCardSequence(groups: ReviewCardGroup[]) {
  return [...groups]
    .sort((left, right) => left.index - right.index)
    .flatMap((group) => orderReviewCards(group.cards));
}

export function findCurrentPendingReviewCard(
  groups: ReviewCardGroup[],
) {
  return orderReviewCardSequence(groups).find((card) => card.status === "pending") ?? null;
}

export function isReviewCardEditable(
  _stage: ReviewCardStage,
  status: ActionCardStatus,
) {
  return status === "pending";
}

export function findReviewAutoFollowScreenshotId(
  groups: ReviewCardGroup[],
  currentScreenshotId: number | null,
) {
  const orderedCards = orderReviewCardSequence(groups);
  const currentScreenshotHasPendingCard = orderedCards.some(
    (card) =>
      card.screenshot_id === currentScreenshotId && card.status === "pending",
  );

  if (currentScreenshotHasPendingCard) {
    return null;
  }

  return orderedCards.find((card) => card.status === "pending")?.screenshot_id ?? null;
}
