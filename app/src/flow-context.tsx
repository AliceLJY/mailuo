import { createContext, useContext, useState, type PropsWithChildren } from "react";

import type {
  ActionCardRecord,
  ConfirmCardResponse,
  ContactDetail,
  InsightRecord,
  ObservationRecord,
  ScreenshotDetail,
  ScreenshotUploadResponse,
} from "@/types";

type FlowContextValue = {
  screenshotId: number | null;
  cards: ActionCardRecord[];
  screenshotDetail: ScreenshotDetail | null;
  insights: InsightRecord[];
  evidenceById: Record<number, ObservationRecord>;
  contactDetailsById: Record<number, ContactDetail>;
  affectedContactIds: number[];
  hasInsightFailure: boolean;
  seedFromUpload: (payload: ScreenshotUploadResponse) => void;
  setScreenshotDetail: (detail: ScreenshotDetail) => void;
  applyConfirmResult: (payload: ConfirmCardResponse) => void;
  markRejected: (card: ActionCardRecord) => void;
  mergeContactDetail: (detail: ContactDetail) => void;
  resetFlow: () => void;
};

const FlowContext = createContext<FlowContextValue | null>(null);

function sortCards(cards: ActionCardRecord[]) {
  return [...cards].sort((left, right) => left.id - right.id);
}

function upsertCard(cards: ActionCardRecord[], card: ActionCardRecord) {
  const next = cards.filter((entry) => entry.id !== card.id);
  next.push(card);
  return sortCards(next);
}

function mergeUniqueIds(current: number[], incoming: number[]) {
  return [...new Set([...current, ...incoming])];
}

export function FlowProvider({ children }: PropsWithChildren) {
  const [screenshotId, setScreenshotId] = useState<number | null>(null);
  const [cards, setCards] = useState<ActionCardRecord[]>([]);
  const [screenshotDetail, setScreenshotDetailState] = useState<ScreenshotDetail | null>(null);
  const [insights, setInsights] = useState<InsightRecord[]>([]);
  const [evidenceById, setEvidenceById] = useState<Record<number, ObservationRecord>>({});
  const [contactDetailsById, setContactDetailsById] = useState<Record<number, ContactDetail>>({});
  const [affectedContactIds, setAffectedContactIds] = useState<number[]>([]);
  const [hasInsightFailure, setHasInsightFailure] = useState(false);

  const value: FlowContextValue = {
    screenshotId,
    cards,
    screenshotDetail,
    insights,
    evidenceById,
    contactDetailsById,
    affectedContactIds,
    hasInsightFailure,
    seedFromUpload(payload) {
      setScreenshotId(payload.screenshot_id);
      setCards(sortCards(payload.cards));
      setScreenshotDetailState(null);
      setInsights([]);
      setEvidenceById({});
      setContactDetailsById({});
      setAffectedContactIds([]);
      setHasInsightFailure(false);
    },
    setScreenshotDetail(detail) {
      const isSameScreenshot = detail.id === screenshotId;
      setScreenshotId(detail.id);
      setScreenshotDetailState(detail);
      setCards(sortCards(detail.cards));

      if (!isSameScreenshot) {
        setInsights([]);
        setEvidenceById({});
        setContactDetailsById({});
        setAffectedContactIds([]);
        setHasInsightFailure(false);
      }
    },
    applyConfirmResult(payload) {
      setCards((current) => upsertCard(current, payload.card));
      setInsights((current) => [...payload.insights, ...current].filter((item, index, list) => {
        return list.findIndex((entry) => entry.id === item.id) === index;
      }));
      setAffectedContactIds((current) => mergeUniqueIds(current, payload.affected_contact_ids));
      if (payload.insight_status === "failed") {
        setHasInsightFailure(true);
      }
      setScreenshotDetailState((current) => {
        if (!current || current.id !== payload.card.screenshot_id) {
          return current;
        }

        return {
          ...current,
          cards: upsertCard(current.cards, payload.card),
        };
      });
    },
    markRejected(card) {
      setCards((current) => upsertCard(current, card));
      setScreenshotDetailState((current) => {
        if (!current || current.id !== card.screenshot_id) {
          return current;
        }

        return {
          ...current,
          cards: upsertCard(current.cards, card),
        };
      });
    },
    mergeContactDetail(detail) {
      setContactDetailsById((current) => ({
        ...current,
        [detail.contact.id]: detail,
      }));

      const nextEvidence: Record<number, ObservationRecord> = {};
      for (const observation of detail.observations) {
        nextEvidence[observation.id] = observation;
      }

      setEvidenceById((current) => ({
        ...current,
        ...nextEvidence,
      }));
    },
    resetFlow() {
      setScreenshotId(null);
      setCards([]);
      setScreenshotDetailState(null);
      setInsights([]);
      setEvidenceById({});
      setContactDetailsById({});
      setAffectedContactIds([]);
      setHasInsightFailure(false);
    },
  };

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>;
}

export function useFlow() {
  const context = useContext(FlowContext);

  if (!context) {
    throw new Error("useFlow must be used inside FlowProvider");
  }

  return context;
}
