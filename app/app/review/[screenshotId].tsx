import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";

import {
  confirmCard,
  getContactDetail,
  getErrorMessage,
  getScreenshotDetail,
  isConflictError,
  rejectCard,
} from "@/api";
import { AppButton } from "@/components/button";
import { EmptyHint, Page, SectionCard } from "@/components/page";
import { ReviewCard } from "@/components/review/review-card";
import { useFlow } from "@/flow-context";
import { useToast } from "@/toast-context";
import type { ActionCardRecord, ReviewCardDraft } from "@/types";

const CARD_ORDER = {
  create_contact: 0,
  update_contact: 1,
  create_meeting: 2,
  record_interaction: 3,
} satisfies Record<ActionCardRecord["type"], number>;

function orderCards(cards: ActionCardRecord[]) {
  return [...cards].sort((left, right) => {
    const leftRank = CARD_ORDER[left.type];
    const rightRank = CARD_ORDER[right.type];
    return leftRank === rightRank ? left.id - right.id : leftRank - rightRank;
  });
}

function cloneDraft(card: ActionCardRecord): ReviewCardDraft {
  return {
    payload: JSON.parse(JSON.stringify(card.payload)) as ReviewCardDraft["payload"],
    resolved_contact_id: card.resolved_contact_id,
  };
}

function syncDrafts(current: Record<number, ReviewCardDraft>, cards: ActionCardRecord[]) {
  const next: Record<number, ReviewCardDraft> = {};

  for (const card of cards) {
    if (card.status !== "pending") {
      continue;
    }

    next[card.id] = current[card.id] ?? cloneDraft(card);
  }

  return next;
}

export default function ReviewScreen() {
  const params = useLocalSearchParams<{ screenshotId?: string }>();
  const id = Number(params.screenshotId);
  const [loadingCardId, setLoadingCardId] = useState<number | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, ReviewCardDraft>>({});
  const {
    applyConfirmResult,
    cards,
    markRejected,
    mergeContactDetail,
    processingNotice,
    screenshotDetail,
    screenshotId,
    setScreenshotDetail,
  } = useFlow();
  const { showError, showToast } = useToast();
  const hasRouteSnapshot = screenshotId === id;
  const orderedCards = useMemo(() => {
    if (!hasRouteSnapshot) {
      return [];
    }

    return orderCards(cards.filter((card) => card.screenshot_id === id));
  }, [cards, hasRouteSnapshot, id]);
  const currentPendingCard = orderedCards.find((card) => card.status === "pending") ?? null;
  const isValidId = Number.isSafeInteger(id) && id > 0;

  useEffect(() => {
    setDrafts((current) => syncDrafts(current, orderedCards));
  }, [orderedCards]);

  useEffect(() => {
    if (!isValidId) {
      return;
    }

    if (hasRouteSnapshot || screenshotDetail?.id === id) {
      setPageError(null);
      setActionError(null);
      return;
    }

    let active = true;

    void (async () => {
      try {
        if (active) {
          setPageError(null);
          setActionError(null);
          setLoadingCardId(null);
        }
        const detail = await getScreenshotDetail(id);
        if (active) {
          setScreenshotDetail(detail);
        }
      } catch (error) {
        if (!active) {
          return;
        }

        const message = getErrorMessage(error, "这张截图加载失败。");
        setPageError(message);
        showError(error, "这张截图加载失败。");
      }
    })();

    return () => {
      active = false;
    };
  }, [hasRouteSnapshot, id, isValidId, screenshotDetail?.id, setScreenshotDetail, showError]);

  useEffect(() => {
    if (!isValidId || !hasRouteSnapshot || currentPendingCard) {
      return;
    }

    router.replace("/insights");
  }, [currentPendingCard, hasRouteSnapshot, isValidId]);

  async function refreshScreenshot(message?: string) {
    const detail = await getScreenshotDetail(id);
    setScreenshotDetail(detail);
    setActionError(null);
    if (message) {
      showToast(message, "info");
    }
  }

  async function hydrateAffectedContacts(contactIds: number[]) {
    if (!contactIds.length) {
      return;
    }

    const results = await Promise.allSettled(contactIds.map((contactId) => getContactDetail(contactId)));
    let hasFailure = false;

    for (const result of results) {
      if (result.status === "fulfilled") {
        mergeContactDetail(result.value);
        continue;
      }

      hasFailure = true;
    }

    if (hasFailure) {
      showToast("补充资料加载失败。", "error");
    }
  }

  async function handleConfirm(card: ActionCardRecord) {
    if (!hasRouteSnapshot || card.screenshot_id !== id) {
      return;
    }

    try {
      setLoadingCardId(card.id);
      setActionError(null);
      const draft = drafts[card.id] ?? cloneDraft(card);
      const result = await confirmCard(card.id, {
        payload: draft.payload,
        ...(draft.resolved_contact_id != null
          ? { resolved_contact_id: draft.resolved_contact_id }
          : {}),
      });
      applyConfirmResult(result);
      setLoadingCardId(null);
      if (result.insight_status === "failed") {
        showToast("这次洞察暂时没生成，但档案已经保存。", "info");
      }
      void hydrateAffectedContacts(result.affected_contact_ids);
    } catch (error) {
      if (isConflictError(error)) {
        try {
          await refreshScreenshot("这张卡刚刚已经处理过，内容已刷新。");
        } catch (refreshError) {
          const message = getErrorMessage(refreshError, "刷新状态失败。");
          setActionError(message);
          showError(refreshError, "刷新状态失败。");
        }
        return;
      }

      const message = getErrorMessage(error, "确认失败。");
      setActionError(message);
      showError(error, "确认失败。");
    } finally {
      setLoadingCardId((current) => (current === card.id ? null : current));
    }
  }

  async function handleReject(card: ActionCardRecord) {
    if (!hasRouteSnapshot || card.screenshot_id !== id) {
      return;
    }

    try {
      setLoadingCardId(card.id);
      setActionError(null);
      const result = await rejectCard(card.id);
      markRejected(result.card);
    } catch (error) {
      if (isConflictError(error)) {
        try {
          await refreshScreenshot("这张卡刚刚已经处理过，内容已刷新。");
        } catch (refreshError) {
          const message = getErrorMessage(refreshError, "刷新状态失败。");
          setActionError(message);
          showError(refreshError, "刷新状态失败。");
        }
        return;
      }

      const message = getErrorMessage(error, "跳过失败。");
      setActionError(message);
      showError(error, "跳过失败。");
    } finally {
      setLoadingCardId(null);
    }
  }

  if (!isValidId) {
    return <Page title="确认卡片"><EmptyHint text="页面地址无效。" /></Page>;
  }

  return (
    <Page
      title="确认卡片"
      subtitle="按 新联系人 → 更新联系人 → 新会议 → 互动记录 的顺序逐张处理。当前这张可以直接调整，后面的内容也能先看看。"
    >
      {pageError ? (
        <SectionCard title="加载失败">
          <EmptyHint text={pageError} />
          <AppButton
            label="重新加载"
            onPress={() => {
              void refreshScreenshot().catch((error) => {
                const message = getErrorMessage(error, "这张截图加载失败。");
                setPageError(message);
                showError(error, "这张截图加载失败。");
              });
            }}
          />
        </SectionCard>
      ) : null}

      {processingNotice && hasRouteSnapshot ? (
        <SectionCard title="处理提示">
          <EmptyHint text={processingNotice} />
        </SectionCard>
      ) : null}

      {!orderedCards.length && !pageError && !hasRouteSnapshot ? <EmptyHint text="正在找回这张截图的待确认内容..." /> : null}

      {!orderedCards.length && !pageError && hasRouteSnapshot ? (
        <SectionCard title="没有待确认内容">
          <EmptyHint text="这张截图暂时没有需要确认的内容，可以返回继续上传。" />
        </SectionCard>
      ) : null}

      {orderedCards.map((card) => {
        const stage =
          card.status !== "pending" ? "done" : currentPendingCard?.id === card.id ? "current" : "upcoming";

        return (
          <ReviewCard
            key={card.id}
            busy={loadingCardId === card.id}
            card={card}
            draft={drafts[card.id] ?? cloneDraft(card)}
            errorText={stage === "current" ? actionError : null}
            onConfirm={() => void handleConfirm(card)}
            onDraftChange={(draft) =>
              setDrafts((current) => ({
                ...current,
                [card.id]: draft,
              }))
            }
            onReject={() => void handleReject(card)}
            stage={stage}
          />
        );
      })}
    </Page>
  );
}
