import { createContext, useContext, useRef, useState, type PropsWithChildren } from "react";

import {
  getUploadAssetLabel,
  type UploadBatchMode,
  type UploadBatchResult,
  type UploadBatchStatus,
} from "@/upload-batch";
import type { LocalBatchContactSession } from "@/local/batch-contacts";
import type {
  ActionCardRecord,
  ConfirmCardResponse,
  ContactDetail,
  InsightRecord,
  ObservationRecord,
  ScreenshotDetail,
  ScreenshotUploadResponse,
  UploadImageAsset,
} from "@/types";

export type FlowBatchItemStatus = "pending" | "processing" | "success" | "failure";

export type FlowBatchItem = {
  index: number;
  asset: UploadImageAsset | null;
  label: string;
  status: FlowBatchItemStatus;
  screenshotId: number | null;
  cards: ActionCardRecord[];
  detail: ScreenshotDetail | null;
  processingNotice: string | null;
  error: string | null;
};

export type FlowBatchSummary = {
  status: UploadBatchStatus;
  totalCount: number;
  successCount: number;
  failureCount: number;
};

type BatchFlowState = {
  mode: UploadBatchMode | null;
  serverUrl: string | null;
  note: string;
  localBatchSession: LocalBatchContactSession | null;
  items: FlowBatchItem[];
  summary: FlowBatchSummary | null;
  sourceScreenshotIdsByCardId: Record<number, number[]>;
};

type BeginBatchInput = {
  assets: UploadImageAsset[];
  note?: string;
  mode: UploadBatchMode;
  serverUrl?: string | null;
  localBatchSession?: LocalBatchContactSession | null;
};

export type ResetFlowOptions = {
  preserveExistingBatch?: boolean;
};

type FlowContextValue = {
  screenshotId: number | null;
  cards: ActionCardRecord[];
  screenshotDetail: ScreenshotDetail | null;
  batchItems: FlowBatchItem[];
  batchSummary: FlowBatchSummary | null;
  batchMode: UploadBatchMode | null;
  batchServerUrl: string | null;
  batchNote: string;
  localBatchSession: LocalBatchContactSession | null;
  flowGeneration: number;
  cardSourceLabelsById: Record<number, string[]>;
  insights: InsightRecord[];
  evidenceById: Record<number, ObservationRecord>;
  contactDetailsById: Record<number, ContactDetail>;
  affectedContactIds: number[];
  hasInsightFailure: boolean;
  processingNotice: string | null;
  beginBatch: (input: BeginBatchInput) => number;
  isFlowGenerationCurrent: (generation: number) => boolean;
  markBatchItemProcessing: (index: number) => void;
  recordBatchItemSuccess: (index: number, payload: ScreenshotUploadResponse) => void;
  recordBatchItemFailure: (index: number, reason: string) => void;
  finishBatch: (result: UploadBatchResult) => void;
  selectScreenshot: (screenshotId: number) => void;
  seedFromUpload: (payload: ScreenshotUploadResponse) => void;
  setScreenshotDetail: (detail: ScreenshotDetail) => void;
  applyConfirmResult: (payload: ConfirmCardResponse) => void;
  markRejected: (card: ActionCardRecord) => void;
  mergeContactDetail: (detail: ContactDetail) => void;
  resetFlow: (options?: ResetFlowOptions) => void;
};

const EMPTY_BATCH: BatchFlowState = {
  mode: null,
  serverUrl: null,
  note: "",
  localBatchSession: null,
  items: [],
  summary: null,
  sourceScreenshotIdsByCardId: {},
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

function upsertCards(cards: ActionCardRecord[], incoming: ActionCardRecord[]) {
  return incoming.reduce(upsertCard, cards);
}

function replaceScreenshotCards(
  cards: ActionCardRecord[],
  screenshotId: number,
  incoming: ActionCardRecord[],
) {
  return sortCards([
    ...cards.filter((card) => card.screenshot_id !== screenshotId),
    ...incoming,
  ]);
}

function mergeUniqueIds(current: number[], incoming: number[]) {
  return [...new Set([...current, ...incoming])];
}

function updateCardInBatchItems(items: FlowBatchItem[], card: ActionCardRecord) {
  let updated = false;
  const next = items.map((item) => {
    if (!item.cards.some((entry) => entry.id === card.id)) {
      return item;
    }

    updated = true;
    const cards = upsertCard(item.cards, card);
    return {
      ...item,
      cards,
      detail: item.detail ? { ...item.detail, cards } : null,
    };
  });

  if (updated) {
    return next;
  }

  return next.map((item) => {
    if (item.screenshotId !== card.screenshot_id) {
      return item;
    }

    const cards = upsertCard(item.cards, card);
    return {
      ...item,
      cards,
      detail: item.detail ? { ...item.detail, cards } : null,
    };
  });
}

function applyUploadResponseToItems(
  items: FlowBatchItem[],
  index: number,
  payload: ScreenshotUploadResponse,
) {
  let next = items.map((item) =>
    item.index === index
      ? {
          ...item,
          status: "success" as const,
          screenshotId: payload.screenshot_id,
          cards: sortCards(payload.cards),
          detail: null,
          processingNotice: payload.processing_notice ?? null,
          error: null,
        }
      : item,
  );

  for (const merge of payload.local_batch_contact_merges ?? []) {
    next = updateCardInBatchItems(next, merge.anchor_card);
  }

  return next;
}

function applyUploadResponseSources(
  current: Record<number, number[]>,
  payload: ScreenshotUploadResponse,
) {
  const next = { ...current };

  for (const card of payload.cards) {
    next[card.id] ??= [card.screenshot_id];
  }

  for (const merge of payload.local_batch_contact_merges ?? []) {
    const screenshotIds = merge.evidence.map((item) => item.screenshot_id);
    next[merge.anchor_card.id] = mergeUniqueIds(
      next[merge.anchor_card.id] ?? [merge.anchor_card.screenshot_id],
      screenshotIds,
    );
  }

  return next;
}

function summaryFromItems(items: FlowBatchItem[]): FlowBatchSummary {
  const successCount = items.filter((item) => item.status === "success").length;
  const failureCount = items.filter((item) => item.status === "failure").length;

  return {
    status:
      successCount === 0
        ? "failed"
        : failureCount === 0
          ? "success"
          : "partial_success",
    totalCount: items.length,
    successCount,
    failureCount,
  };
}

function getBatchProcessingNotice(items: FlowBatchItem[]) {
  const notices = items
    .filter((item) => item.processingNotice)
    .map((item) => ({ label: item.label, notice: item.processingNotice as string }));

  if (notices.length === 0) {
    return null;
  }

  if (items.length === 1) {
    return notices[0].notice;
  }

  return notices.map((item) => `${item.label}：${item.notice}`).join(" ");
}

export function shouldPreserveBatchOnReset(
  items: ReadonlyArray<Pick<FlowBatchItem, "status">>,
  hasSummary: boolean,
  options?: ResetFlowOptions,
) {
  const isInProgress = !hasSummary && items.some(
    (item) => item.status === "pending" || item.status === "processing",
  );

  return isInProgress || Boolean(options?.preserveExistingBatch && items.length > 0);
}

function getCardSourceLabels(
  items: FlowBatchItem[],
  sourceScreenshotIdsByCardId: Record<number, number[]>,
) {
  const labelByScreenshotId = new Map<number, string>();
  for (const item of items) {
    if (item.screenshotId != null) {
      labelByScreenshotId.set(item.screenshotId, item.label);
    }
  }

  const labels: Record<number, string[]> = {};
  for (const item of items) {
    for (const card of item.cards) {
      const screenshotIds = sourceScreenshotIdsByCardId[card.id] ?? [card.screenshot_id];
      labels[card.id] = screenshotIds.map(
        (sourceScreenshotId) => labelByScreenshotId.get(sourceScreenshotId) ?? `截图 #${sourceScreenshotId}`,
      );
    }
  }

  return labels;
}

export function FlowProvider({ children }: PropsWithChildren) {
  const generationRef = useRef(0);
  const [flowGeneration, setFlowGeneration] = useState(0);
  const [screenshotId, setScreenshotId] = useState<number | null>(null);
  const [cards, setCards] = useState<ActionCardRecord[]>([]);
  const [screenshotDetail, setScreenshotDetailState] = useState<ScreenshotDetail | null>(null);
  const [batch, setBatch] = useState<BatchFlowState>(EMPTY_BATCH);
  const [insights, setInsights] = useState<InsightRecord[]>([]);
  const [evidenceById, setEvidenceById] = useState<Record<number, ObservationRecord>>({});
  const [contactDetailsById, setContactDetailsById] = useState<Record<number, ContactDetail>>({});
  const [affectedContactIds, setAffectedContactIds] = useState<number[]>([]);
  const [hasInsightFailure, setHasInsightFailure] = useState(false);
  const processingNotice = getBatchProcessingNotice(batch.items);
  const cardSourceLabelsById = getCardSourceLabels(
    batch.items,
    batch.sourceScreenshotIdsByCardId,
  );

  function clearResultState() {
    setScreenshotId(null);
    setCards([]);
    setScreenshotDetailState(null);
    setInsights([]);
    setEvidenceById({});
    setContactDetailsById({});
    setAffectedContactIds([]);
    setHasInsightFailure(false);
  }

  function advanceFlowGeneration() {
    const nextGeneration = generationRef.current + 1;
    generationRef.current = nextGeneration;
    setFlowGeneration(nextGeneration);
    return nextGeneration;
  }

  const value: FlowContextValue = {
    screenshotId,
    cards,
    screenshotDetail,
    batchItems: batch.items,
    batchSummary: batch.summary,
    batchMode: batch.mode,
    batchServerUrl: batch.serverUrl,
    batchNote: batch.note,
    localBatchSession: batch.localBatchSession,
    flowGeneration,
    cardSourceLabelsById,
    insights,
    evidenceById,
    contactDetailsById,
    affectedContactIds,
    hasInsightFailure,
    processingNotice,
    beginBatch({ assets, localBatchSession = null, mode, note = "", serverUrl = null }) {
      const nextGeneration = advanceFlowGeneration();
      clearResultState();
      setBatch({
        mode,
        serverUrl: mode === "server" ? serverUrl : null,
        note,
        localBatchSession,
        summary: null,
        sourceScreenshotIdsByCardId: {},
        items: assets.map((asset, index) => ({
          index,
          asset,
          label: getUploadAssetLabel(asset),
          status: "pending",
          screenshotId: null,
          cards: [],
          detail: null,
          processingNotice: null,
          error: null,
        })),
      });
      return nextGeneration;
    },
    isFlowGenerationCurrent(generation) {
      return generationRef.current === generation;
    },
    markBatchItemProcessing(index) {
      setBatch((current) => ({
        ...current,
        summary: null,
        items: current.items.map((item) =>
          item.index === index
            ? { ...item, status: "processing", error: null }
            : item,
        ),
      }));
    },
    recordBatchItemSuccess(index, payload) {
      setBatch((current) => ({
        ...current,
        items: applyUploadResponseToItems(current.items, index, payload),
        sourceScreenshotIdsByCardId: applyUploadResponseSources(
          current.sourceScreenshotIdsByCardId,
          payload,
        ),
      }));
      setCards((current) => {
        let next = upsertCards(current, payload.cards);
        for (const merge of payload.local_batch_contact_merges ?? []) {
          next = upsertCard(next, merge.anchor_card);
        }
        return next;
      });
      setScreenshotId((current) => current ?? payload.screenshot_id);
    },
    recordBatchItemFailure(index, reason) {
      setBatch((current) => ({
        ...current,
        items: current.items.map((item) =>
          item.index === index
            ? {
                ...item,
                status: "failure",
                screenshotId: null,
                cards: [],
                detail: null,
                processingNotice: null,
                error: reason,
              }
            : item,
        ),
      }));
    },
    finishBatch(result) {
      const successfulResponses = result.items.flatMap((item) =>
        item.status === "success" ? [item.response] : [],
      );

      setCards((current) => {
        let next = current;
        for (const response of successfulResponses) {
          next = upsertCards(next, response.cards);
          for (const merge of response.local_batch_contact_merges ?? []) {
            next = upsertCard(next, merge.anchor_card);
          }
        }
        return next;
      });
      const firstSuccessfulScreenshotId = successfulResponses[0]?.screenshot_id;
      if (firstSuccessfulScreenshotId != null) {
        setScreenshotId((current) => current ?? firstSuccessfulScreenshotId);
      }
      setBatch((current) => {
        let items = current.items;
        let sources = current.sourceScreenshotIdsByCardId;

        for (const resultItem of result.items) {
          if (resultItem.status === "success") {
            items = applyUploadResponseToItems(items, resultItem.index, resultItem.response);
            sources = applyUploadResponseSources(sources, resultItem.response);
          } else {
            items = items.map((item) =>
              item.index === resultItem.index
                ? {
                    ...item,
                    status: "failure" as const,
                    screenshotId: null,
                    cards: [],
                    detail: null,
                    processingNotice: null,
                    error: resultItem.reason,
                  }
                : item,
            );
          }
        }

        return {
          ...current,
          mode: result.mode,
          serverUrl: result.serverUrl,
          items,
          summary: summaryFromItems(items),
          sourceScreenshotIdsByCardId: sources,
        };
      });
    },
    selectScreenshot(nextScreenshotId) {
      setScreenshotId(nextScreenshotId);
      setScreenshotDetailState(
        batch.items.find((item) => item.screenshotId === nextScreenshotId)?.detail ?? null,
      );
    },
    seedFromUpload(payload) {
      advanceFlowGeneration();
      const label = `截图 #${payload.screenshot_id}`;
      const item: FlowBatchItem = {
        index: 0,
        asset: null,
        label,
        status: "success",
        screenshotId: payload.screenshot_id,
        cards: sortCards(payload.cards),
        detail: null,
        processingNotice: payload.processing_notice ?? null,
        error: null,
      };
      const items = applyUploadResponseToItems([item], 0, payload);

      clearResultState();
      setScreenshotId(payload.screenshot_id);
      setCards(upsertCards([], [
        ...payload.cards,
        ...(payload.local_batch_contact_merges ?? []).map((merge) => merge.anchor_card),
      ]));
      setBatch({
        mode: null,
        serverUrl: null,
        note: "",
        localBatchSession: null,
        items,
        summary: summaryFromItems(items),
        sourceScreenshotIdsByCardId: applyUploadResponseSources({}, payload),
      });
    },
    setScreenshotDetail(detail) {
      const belongsToCurrentBatch = batch.items.some(
        (item) => item.screenshotId === detail.id,
      );

      if (!belongsToCurrentBatch) {
        advanceFlowGeneration();
      }

      setScreenshotId(detail.id);
      setScreenshotDetailState(detail);
      setCards((current) =>
        belongsToCurrentBatch
          ? replaceScreenshotCards(current, detail.id, detail.cards)
          : sortCards(detail.cards),
      );
      setBatch((current) => {
        const hasItem = current.items.some((item) => item.screenshotId === detail.id);
        if (hasItem) {
          return {
            ...current,
            items: current.items.map((item) =>
              item.screenshotId === detail.id
                ? { ...item, cards: sortCards(detail.cards), detail }
                : item,
            ),
          };
        }

        const label = detail.image_path.split("/").filter(Boolean).at(-1) ?? `截图 #${detail.id}`;
        const item: FlowBatchItem = {
          index: 0,
          asset: { uri: detail.image_path, fileName: label },
          label,
          status: "success",
          screenshotId: detail.id,
          cards: sortCards(detail.cards),
          detail,
          processingNotice: null,
          error: null,
        };

        return {
          mode: null,
          serverUrl: null,
          note: detail.user_note ?? "",
          localBatchSession: null,
          items: [item],
          summary: summaryFromItems([item]),
          sourceScreenshotIdsByCardId: Object.fromEntries(
            detail.cards.map((card) => [card.id, [detail.id]]),
          ),
        };
      });

      if (!belongsToCurrentBatch) {
        setInsights([]);
        setEvidenceById({});
        setContactDetailsById({});
        setAffectedContactIds([]);
        setHasInsightFailure(false);
      }
    },
    applyConfirmResult(payload) {
      setCards((current) => upsertCard(current, payload.card));
      setBatch((current) => ({
        ...current,
        items: updateCardInBatchItems(current.items, payload.card),
      }));
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
      setBatch((current) => ({
        ...current,
        items: updateCardInBatchItems(current.items, card),
      }));
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
    resetFlow(options) {
      if (shouldPreserveBatchOnReset(batch.items, batch.summary != null, options)) {
        return;
      }

      advanceFlowGeneration();
      clearResultState();
      setBatch(EMPTY_BATCH);
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
