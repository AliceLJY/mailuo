import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";

import {
  confirmCard,
  getContactDetail,
  getConfiguredApiUrl,
  getErrorMessage,
  getScreenshotDetail,
  isConflictError,
  rejectCard,
} from "@/api";
import { AppButton } from "@/components/button";
import { EmptyHint, Page, SectionCard } from "@/components/page";
import { ReviewCard } from "@/components/review/review-card";
import { useConnection } from "@/connection/context";
import { useFlow, type FlowBatchItem } from "@/flow-context";
import { findCurrentPendingReviewCard, orderReviewCards } from "@/review-order";
import { theme } from "@/theme";
import { useToast } from "@/toast-context";
import type { ActionCardRecord, ReviewCardDraft } from "@/types";
import {
  normalizeUploadServerUrl,
  uploadBatchTargetMatches,
} from "@/upload-batch";

const ITEM_STATUS_LABEL = {
  pending: "等待处理",
  processing: "处理中",
  success: "处理完成",
  failure: "处理失败",
} satisfies Record<FlowBatchItem["status"], string>;

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

function canCommitReviewAsync(
  mountedRef: { current: boolean },
  tokenRef: { current: number },
  token: number,
  generation: number,
  isFlowGenerationCurrent: (generation: number) => boolean,
) {
  return (
    mountedRef.current &&
    tokenRef.current === token &&
    isFlowGenerationCurrent(generation)
  );
}

export default function ReviewScreen() {
  const params = useLocalSearchParams<{ screenshotId?: string }>();
  const id = Number(params.screenshotId);
  const [loadingCardId, setLoadingCardId] = useState<number | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, ReviewCardDraft>>({});
  const mountedRef = useRef(true);
  const loadRunTokenRef = useRef(0);
  const actionRunTokenRef = useRef(0);
  const actionRunningRef = useRef(false);
  const {
    applyConfirmResult,
    batchItems,
    batchMode,
    batchServerUrl,
    batchSummary,
    cards,
    cardSourceLabelsById,
    flowGeneration,
    isFlowGenerationCurrent,
    markRejected,
    mergeContactDetail,
    screenshotDetail,
    screenshotId,
    selectScreenshot,
    setScreenshotDetail,
  } = useFlow();
  const { showError, showToast } = useToast();
  const { config } = useConnection();
  const currentMode = Platform.OS !== "web" && config?.mode === "local" ? "local" : "server";
  const currentServerUrl = normalizeUploadServerUrl(
    config?.serverUrl ?? getConfiguredApiUrl(),
  );
  const targetMismatch = batchMode != null && !uploadBatchTargetMatches({
    batchMode,
    batchServerUrl,
    currentMode,
    currentServerUrl,
  });
  const orderedGroups = useMemo(() => {
    const latestCards = new Map(cards.map((card) => [card.id, card]));

    return [...batchItems]
      .sort((left, right) => left.index - right.index)
      .map((item) => ({
        item,
        cards: orderReviewCards(item.cards.map((card) => latestCards.get(card.id) ?? card)),
      }));
  }, [batchItems, cards]);
  const orderedCards = useMemo(
    () => orderedGroups.flatMap((group) => group.cards),
    [orderedGroups],
  );
  const currentPendingCard = useMemo(
    () => findCurrentPendingReviewCard(
      orderedGroups.map((group) => ({ index: group.item.index, cards: group.cards })),
      batchMode,
    ),
    [batchMode, orderedGroups],
  );
  const successfulScreenshotIds = useMemo(
    () => new Set(batchItems.flatMap((item) =>
      item.status === "success" && item.screenshotId != null ? [item.screenshotId] : [],
    )),
    [batchItems],
  );
  const hasRouteSnapshot = successfulScreenshotIds.has(id);
  const batchSettled = batchItems.length > 0 && batchItems.every(
    (item) => item.status === "success" || item.status === "failure",
  );
  const isValidId = Number.isSafeInteger(id) && id > 0;

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      loadRunTokenRef.current += 1;
      actionRunTokenRef.current += 1;
      actionRunningRef.current = false;
    };
  }, []);

  useEffect(() => {
    actionRunTokenRef.current += 1;
    actionRunningRef.current = false;
    setLoadingCardId(null);
    setActionError(null);
  }, [flowGeneration]);

  useEffect(() => {
    setDrafts((current) => syncDrafts(current, orderedCards));
  }, [orderedCards]);

  useEffect(() => {
    if (!currentPendingCard || screenshotId === currentPendingCard.screenshot_id) {
      return;
    }

    selectScreenshot(currentPendingCard.screenshot_id);
  }, [currentPendingCard?.id]);

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
    const requestGeneration = flowGeneration;
    const runToken = loadRunTokenRef.current + 1;
    loadRunTokenRef.current = runToken;

    void (async () => {
      try {
        if (
          active &&
          canCommitReviewAsync(
            mountedRef,
            loadRunTokenRef,
            runToken,
            requestGeneration,
            isFlowGenerationCurrent,
          )
        ) {
          setPageError(null);
          setActionError(null);
          setLoadingCardId(null);
        }
        const detail = await getScreenshotDetail(id);
        if (
          active &&
          canCommitReviewAsync(
            mountedRef,
            loadRunTokenRef,
            runToken,
            requestGeneration,
            isFlowGenerationCurrent,
          )
        ) {
          setScreenshotDetail(detail);
        }
      } catch (error) {
        if (
          !active ||
          !canCommitReviewAsync(
            mountedRef,
            loadRunTokenRef,
            runToken,
            requestGeneration,
            isFlowGenerationCurrent,
          )
        ) {
          return;
        }

        const message = getErrorMessage(error, "这张截图加载失败。");
        setPageError(message);
        showError(error, "这张截图加载失败。");
      }
    })();

    return () => {
      active = false;
      if (loadRunTokenRef.current === runToken) {
        loadRunTokenRef.current += 1;
      }
    };
  }, [
    flowGeneration,
    hasRouteSnapshot,
    id,
    isFlowGenerationCurrent,
    isValidId,
    screenshotDetail?.id,
    setScreenshotDetail,
    showError,
  ]);

  useEffect(() => {
    if (
      !isValidId ||
      !hasRouteSnapshot ||
      !batchSettled ||
      targetMismatch ||
      currentPendingCard ||
      (batchSummary?.failureCount ?? 0) > 0
    ) {
      return;
    }

    router.replace("/insights");
  }, [
    batchSettled,
    batchSummary?.failureCount,
    currentPendingCard,
    hasRouteSnapshot,
    isValidId,
    targetMismatch,
  ]);

  async function refreshScreenshot(
    targetScreenshotId: number,
    generation: number,
    tokenRef: { current: number },
    runToken: number,
    message?: string,
  ) {
    const detail = await getScreenshotDetail(targetScreenshotId);
    if (
      !canCommitReviewAsync(
        mountedRef,
        tokenRef,
        runToken,
        generation,
        isFlowGenerationCurrent,
      )
    ) {
      return false;
    }

    setScreenshotDetail(detail);
    setPageError(null);
    setActionError(null);
    if (message) {
      showToast(message, "info");
    }
    return true;
  }

  async function hydrateAffectedContacts(
    contactIds: number[],
    generation: number,
    runToken: number,
  ) {
    if (!contactIds.length) {
      return;
    }

    const results = await Promise.allSettled(contactIds.map((contactId) => getContactDetail(contactId)));
    if (
      !canCommitReviewAsync(
        mountedRef,
        actionRunTokenRef,
        runToken,
        generation,
        isFlowGenerationCurrent,
      )
    ) {
      return;
    }

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
    if (
      actionRunningRef.current ||
      targetMismatch ||
      !successfulScreenshotIds.has(card.screenshot_id)
    ) {
      return;
    }

    actionRunningRef.current = true;
    const requestGeneration = flowGeneration;
    const runToken = actionRunTokenRef.current + 1;
    actionRunTokenRef.current = runToken;
    selectScreenshot(card.screenshot_id);
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
      if (
        !canCommitReviewAsync(
          mountedRef,
          actionRunTokenRef,
          runToken,
          requestGeneration,
          isFlowGenerationCurrent,
        )
      ) {
        return;
      }

      applyConfirmResult(result);
      if (result.insight_status === "failed") {
        showToast("这次洞察暂时没生成，但档案已经保存。", "info");
      }
      void hydrateAffectedContacts(result.affected_contact_ids, requestGeneration, runToken);
    } catch (error) {
      if (
        !canCommitReviewAsync(
          mountedRef,
          actionRunTokenRef,
          runToken,
          requestGeneration,
          isFlowGenerationCurrent,
        )
      ) {
        return;
      }

      if (isConflictError(error)) {
        try {
          await refreshScreenshot(
            card.screenshot_id,
            requestGeneration,
            actionRunTokenRef,
            runToken,
            "这张卡刚刚已经处理过，内容已刷新。",
          );
        } catch (refreshError) {
          if (
            !canCommitReviewAsync(
              mountedRef,
              actionRunTokenRef,
              runToken,
              requestGeneration,
              isFlowGenerationCurrent,
            )
          ) {
            return;
          }
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
      if (actionRunTokenRef.current === runToken) {
        actionRunningRef.current = false;
        if (mountedRef.current) {
          setLoadingCardId((current) => (current === card.id ? null : current));
        }
      }
    }
  }

  async function handleReject(card: ActionCardRecord) {
    if (
      actionRunningRef.current ||
      targetMismatch ||
      !successfulScreenshotIds.has(card.screenshot_id)
    ) {
      return;
    }

    actionRunningRef.current = true;
    const requestGeneration = flowGeneration;
    const runToken = actionRunTokenRef.current + 1;
    actionRunTokenRef.current = runToken;
    selectScreenshot(card.screenshot_id);
    try {
      setLoadingCardId(card.id);
      setActionError(null);
      const result = await rejectCard(card.id);
      if (
        !canCommitReviewAsync(
          mountedRef,
          actionRunTokenRef,
          runToken,
          requestGeneration,
          isFlowGenerationCurrent,
        )
      ) {
        return;
      }

      markRejected(result.card);
    } catch (error) {
      if (
        !canCommitReviewAsync(
          mountedRef,
          actionRunTokenRef,
          runToken,
          requestGeneration,
          isFlowGenerationCurrent,
        )
      ) {
        return;
      }

      if (isConflictError(error)) {
        try {
          await refreshScreenshot(
            card.screenshot_id,
            requestGeneration,
            actionRunTokenRef,
            runToken,
            "这张卡刚刚已经处理过，内容已刷新。",
          );
        } catch (refreshError) {
          if (
            !canCommitReviewAsync(
              mountedRef,
              actionRunTokenRef,
              runToken,
              requestGeneration,
              isFlowGenerationCurrent,
            )
          ) {
            return;
          }
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
      if (actionRunTokenRef.current === runToken) {
        actionRunningRef.current = false;
        if (mountedRef.current) {
          setLoadingCardId((current) => (current === card.id ? null : current));
        }
      }
    }
  }

  if (!isValidId) {
    return <Page title="确认卡片"><EmptyHint text="页面地址无效。" /></Page>;
  }

  return (
    <Page
      title="确认卡片"
      subtitle={
        batchMode === "local"
          ? "卡片仍按截图选择顺序分组；本地批次会优先确认新联系人，再处理依赖这些联系人的其他卡片。"
          : "按截图选择顺序处理；每张截图内按 新联系人 → 更新联系人 → 新会议 → 互动记录 的顺序确认。"
      }
    >
      {pageError ? (
        <SectionCard title="加载失败">
          <EmptyHint text={pageError} />
          <AppButton
            label="重新加载"
            onPress={() => {
              const requestGeneration = flowGeneration;
              const runToken = loadRunTokenRef.current + 1;
              loadRunTokenRef.current = runToken;
              void refreshScreenshot(
                id,
                requestGeneration,
                loadRunTokenRef,
                runToken,
              ).catch((error) => {
                if (
                  !canCommitReviewAsync(
                    mountedRef,
                    loadRunTokenRef,
                    runToken,
                    requestGeneration,
                    isFlowGenerationCurrent,
                  )
                ) {
                  return;
                }
                const message = getErrorMessage(error, "这张截图加载失败。");
                setPageError(message);
                showError(error, "这张截图加载失败。");
              });
            }}
          />
        </SectionCard>
      ) : null}

      {batchSummary && (batchSummary.totalCount > 1 || batchSummary.failureCount > 0) ? (
        <SectionCard title="批次结果">
          <Text style={styles.summaryText}>
            成功 {batchSummary.successCount} 张，失败 {batchSummary.failureCount} 张。
          </Text>
          {batchItems.filter((item) => item.status === "failure").map((item) => (
            <Text key={item.index} style={styles.failureText}>
              {item.label}：{item.error ?? "处理失败，请稍后重试。"}
            </Text>
          ))}
          {batchSummary.failureCount > 0 ? (
            <AppButton
              label="只重试失败的"
              onPress={() => router.back()}
              tone="secondary"
            />
          ) : null}
          {batchSummary.failureCount > 0 && !currentPendingCard ? (
            <AppButton
              disabled={targetMismatch}
              label="暂不重试，查看洞察"
              onPress={() => router.replace("/insights")}
            />
          ) : null}
        </SectionCard>
      ) : null}

      {batchMode === "server" && batchItems.length > 1 ? (
        <SectionCard title="确认提示">
          <Text style={styles.noticeText}>
            服务器模式会分别整理每张截图；同一联系人跨截图出现时，确认时可能会看到多张联系人卡片。
          </Text>
        </SectionCard>
      ) : null}

      {targetMismatch ? (
        <SectionCard title="处理目标已变更">
          <Text style={styles.noticeText}>
            这批卡片属于原来的处理模式与服务地址。请切回原目标后再确认，避免把操作发到另一套档案。
          </Text>
        </SectionCard>
      ) : null}

      {!orderedGroups.length && !pageError ? (
        <EmptyHint text="正在找回这批截图的待确认内容..." />
      ) : null}

      {orderedGroups.map(({ item, cards: groupCards }) => (
        <SectionCard
          key={item.index}
          kicker={`第 ${item.index + 1} 张 · ${
            item.screenshotId === screenshotId ? "当前查看" : ITEM_STATUS_LABEL[item.status]
          }`}
          title={item.label}
        >
          {item.status === "pending" ? <EmptyHint text="等待前面的截图处理完成。" /> : null}
          {item.status === "processing" ? <EmptyHint text="正在处理这张截图…" /> : null}
          {item.status === "failure" ? (
            <EmptyHint text={item.error ?? "这张截图处理失败。"} />
          ) : null}
          {item.processingNotice ? <EmptyHint text={item.processingNotice} /> : null}
          {item.status === "success" && groupCards.length === 0 ? (
            <EmptyHint text="这张截图没有需要确认的内容。" />
          ) : null}
          {groupCards.map((card) => {
            const stage =
              card.status !== "pending"
                ? "done"
                : !targetMismatch && currentPendingCard?.id === card.id
                  ? "current"
                  : "upcoming";

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
                sourceLabels={cardSourceLabelsById[card.id] ?? [item.label]}
                stage={stage}
              />
            );
          })}
        </SectionCard>
      ))}

      <View style={styles.bottomSpacer} />
    </Page>
  );
}

const styles = StyleSheet.create({
  bottomSpacer: { height: 4 },
  failureText: { color: theme.colors.danger, fontSize: 13, lineHeight: 19 },
  noticeText: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 21 },
  summaryText: { color: theme.colors.textPrimary, fontSize: 15, fontWeight: "700", lineHeight: 21 },
});
