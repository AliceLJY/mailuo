import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, StyleSheet, Text, View } from "react-native";

import {
  confirmCard,
  countPendingLocalBatchInteractionCards,
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
import {
  getInteractionDependencyMessage,
  LocalBatchAnchorProvider,
  resolveReviewLocalBatchAnchor,
} from "@/components/review/review-fields";
import { useConnection } from "@/connection/context";
import { setCrashContext } from "@/diagnostics/crash-record";
import { useFlow, type FlowBatchItem } from "@/flow-context";
import {
  buildOrderedReviewGroups,
  findCurrentPendingReviewCard,
} from "@/review-order";
import { theme } from "@/theme";
import { useToast } from "@/toast-context";
import type {
  ActionCardRecord,
  RecordInteractionPayload,
  ReviewCardDraft,
} from "@/types";
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
  const orderedGroups = useMemo(
    () => buildOrderedReviewGroups(batchItems, cards),
    [batchItems, cards],
  );
  const orderedCards = useMemo(
    () => orderedGroups.flatMap((group) => group.cards),
    [orderedGroups],
  );
  const currentPendingCard = useMemo(
    () => findCurrentPendingReviewCard(
      orderedGroups.map((group) => ({ index: group.item.index, cards: group.cards })),
    ),
    [orderedGroups],
  );
  const reviewBatchProgress = useMemo(() => {
    if (batchItems.length === 0) {
      return null;
    }

    const activeGroup = currentPendingCard
      ? orderedGroups.find((group) =>
          group.cards.some((card) => card.id === currentPendingCard.id),
        )
      : orderedGroups.find((group) => group.item.screenshotId === screenshotId);
    if (!activeGroup) {
      return null;
    }

    const batchPosition = batchItems.findIndex(
      (item) => item.index === activeGroup.item.index,
    );
    if (batchPosition < 0) {
      return null;
    }

    return {
      position: batchPosition + 1,
      totalCount: batchItems.length,
      status: activeGroup.item.status,
    };
  }, [batchItems, currentPendingCard, orderedGroups, screenshotId]);
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

  // A render error happens before effects; publish review progress before rendering cards.
  setCrashContext({ batchProgress: reviewBatchProgress });

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      loadRunTokenRef.current += 1;
      actionRunTokenRef.current += 1;
      actionRunningRef.current = false;
    };
  }, []);

  useEffect(() => () => setCrashContext({ batchProgress: null }), []);

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

        const message = getErrorMessage(error, "这项内容加载失败。");
        setPageError(message);
        showError(error, "这项内容加载失败。");
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

    const draft = drafts[card.id] ?? cloneDraft(card);
    const localBatchAnchor = resolveReviewLocalBatchAnchor(
      card,
      orderedCards,
      card.type === "record_interaction"
        ? (draft.payload as RecordInteractionPayload)
        : null,
    );
    const dependencyMessage = getInteractionDependencyMessage(localBatchAnchor);
    if (dependencyMessage) {
      setActionError(dependencyMessage);
      showToast(dependencyMessage, "error");
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

  async function handleReject(
    card: ActionCardRecord,
    dependencyWarningAccepted = false,
  ) {
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
      if (
        !dependencyWarningAccepted &&
        currentMode === "local" &&
        card.type === "create_contact"
      ) {
        const dependentCount = await countPendingLocalBatchInteractionCards(card.id);
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

        if (dependentCount > 0) {
          Alert.alert(
            "确认跳过这位联系人？",
            `后面还有 ${dependentCount} 张互动依赖这位联系人，跳过后它们也需要跳过或改为手动关联`,
            [
              { text: "取消", style: "cancel" },
              {
                text: "仍然跳过",
                style: "destructive",
                onPress: () => void handleReject(card, true),
              },
            ],
          );
          return;
        }
      }

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
      subtitle="按来源选择顺序处理；每个来源内按卡片生成顺序依次确认。"
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
                const message = getErrorMessage(error, "这项内容加载失败。");
                setPageError(message);
                showError(error, "这项内容加载失败。");
              });
            }}
          />
        </SectionCard>
      ) : null}

      {batchSummary && (batchSummary.totalCount > 1 || batchSummary.failureCount > 0) ? (
        <SectionCard title="批次结果">
          <Text style={styles.summaryText}>
            成功 {batchSummary.successCount} 项，失败 {batchSummary.failureCount} 项。
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
        <EmptyHint text="正在找回这批来源的待确认内容..." />
      ) : null}

      {orderedGroups.map(({ item, cards: groupCards }) => (
        <SectionCard
          key={item.index}
          kicker={`第 ${item.index + 1} ${item.asset ? "张" : "项"} · ${
            item.screenshotId === screenshotId ? "当前查看" : ITEM_STATUS_LABEL[item.status]
          }`}
          title={item.label}
        >
          {item.status === "pending" ? <EmptyHint text="等待前面的来源处理完成。" /> : null}
          {item.status === "processing" ? (
            <EmptyHint text={item.asset ? "正在处理这张截图…" : "正在处理这段文本…"} />
          ) : null}
          {item.status === "failure" ? (
            <EmptyHint text={item.error ?? (item.asset ? "这张截图处理失败。" : "这段文本处理失败。")} />
          ) : null}
          {item.processingNotice ? <EmptyHint text={item.processingNotice} /> : null}
          {item.status === "success" && groupCards.length === 0 ? (
            <EmptyHint text={item.asset ? "这张截图没有需要确认的内容。" : "这段文本没有需要确认的内容。"} />
          ) : null}
          {groupCards.map((card) => {
            const stage =
              card.status !== "pending"
                ? "done"
                : !targetMismatch && currentPendingCard?.id === card.id
                  ? "current"
                  : "upcoming";
            const draft = drafts[card.id] ?? cloneDraft(card);
            const localBatchAnchor = resolveReviewLocalBatchAnchor(
              card,
              orderedCards,
              card.type === "record_interaction"
                ? (draft.payload as RecordInteractionPayload)
                : null,
            );

            return (
              <LocalBatchAnchorProvider
                key={card.id}
                value={localBatchAnchor}
              >
                <ReviewCard
                  busy={loadingCardId === card.id}
                  card={card}
                  draft={draft}
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
              </LocalBatchAnchorProvider>
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
