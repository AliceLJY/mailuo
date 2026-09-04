import type {
  ActionCardRecord,
  ActionCardStatus,
  CreateMeetingPayload,
} from "./types";

export type ReviewCardStage = "current" | "upcoming" | "done";

// A blanked-out "related person" field in the confirm form leaves a name: "" entry rather
// than removing the row (there is no dedicated "remove" affordance); MeetingParticipantSchema
// requires a non-empty name, so an empty participants array confirms fine but a
// blank-named one would otherwise be rejected as an invalid create_meeting payload.
export function normalizeMeetingParticipantsForConfirm(
  participants: CreateMeetingPayload["participants"],
): CreateMeetingPayload["participants"] {
  return participants.filter((participant) => participant.name.trim() !== "");
}

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
