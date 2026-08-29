import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { getConfiguredApiUrl, uploadScreenshot, uploadText } from "@/api";
import { AppButton } from "@/components/button";
import { EmptyHint, MetaLine, Page, SectionCard } from "@/components/page";
import { useConnection } from "@/connection/context";
import { humanizeLocalProviderError } from "@/connection/presentation";
import {
  findCompletedPastedTextItem,
  useFlow,
  type FlowBatchItem,
  type FlowBatchSummary,
} from "@/flow-context";
import { LocalBatchContactSession } from "@/local/batch-contacts";
import { theme } from "@/theme";
import { useToast } from "@/toast-context";
import {
  canCommitUploadCompletion,
  shouldAutoOpenUploadReview,
} from "@/upload-lifecycle";
import {
  getFailedUploadItems,
  getUploadAssetLabel,
  mergeUploadBatchResults,
  normalizeUploadServerUrl,
  uploadBatchTargetMatches,
  uploadScreenshotBatch,
  type UploadBatchResult,
  type UploadBatchSourceItem,
  type UploadBatchSuccessItem,
  type UploadBatchMode,
  type UploadBatchItem,
  type UploadBatchProgress,
} from "@/upload-batch";
import { initialUploadDraft, MAX_UPLOAD_ASSETS, uploadDraftReducer } from "@/upload-draft";

type BatchSource =
  | { assets: NonNullable<Parameters<typeof uploadScreenshotBatch>[0]["assets"]> }
  | { items: UploadBatchSourceItem[] };

export default function UploadScreen() {
  const [{ assets, text: pastedText, note }, dispatchDraft] = useReducer(
    uploadDraftReducer,
    initialUploadDraft,
  );
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState("正在准备截图…");
  const [lastResult, setLastResult] = useState<UploadBatchResult | null>(null);
  const {
    batchItems,
    batchMode,
    batchNote,
    batchServerUrl,
    batchSummary,
    beginBatch,
    beginTextUpload,
    finishBatch,
    flowGeneration,
    isFlowGenerationCurrent,
    localBatchSession,
    markBatchItemProcessing,
    recordBatchItemFailure,
    recordBatchItemSuccess,
    resetFlow,
    seedFromUpload,
  } = useFlow();
  const { showError, showToast } = useToast();
  const { config } = useConnection();
  const isLocal = Platform.OS !== "web" && config?.mode === "local";
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localBatchSessionRef = useRef<LocalBatchContactSession | null>(null);
  const mountedRef = useRef(true);
  const focusedRef = useRef(false);
  const focusEpochRef = useRef(0);
  const runningRef = useRef(false);
  const submitTokenRef = useRef(0);
  const flowResult = buildFlowBatchResult(
    batchItems,
    batchSummary,
    batchMode,
    batchServerUrl,
  );
  const displayResult = lastResult ?? flowResult;
  const completedTextItem = findCompletedPastedTextItem(batchItems);
  const hasStoredResult = displayResult != null || completedTextItem != null;
  const currentMode: UploadBatchMode = isLocal ? "local" : "server";
  const currentServerUrl = normalizeUploadServerUrl(
    config?.serverUrl ?? getConfiguredApiUrl(),
  );
  const resultMode = displayResult?.mode ?? (completedTextItem ? batchMode : null);
  const resultServerUrl = displayResult?.serverUrl ?? batchServerUrl;
  const displayMode = resultMode ?? currentMode;
  const targetMismatch = resultMode != null && !uploadBatchTargetMatches({
    batchMode: resultMode,
    batchServerUrl: resultServerUrl,
    currentMode,
    currentServerUrl,
  });
  const displayNote = hasStoredResult && assets.length === 0 ? batchNote : note;

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      submitTokenRef.current += 1;
      clearLoadingTimer(loadingTimerRef.current);
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;

      return () => {
        focusedRef.current = false;
        focusEpochRef.current += 1;
        clearLoadingTimer(loadingTimerRef.current);
        loadingTimerRef.current = null;
      };
    }, []),
  );

  useEffect(() => {
    if (batchItems.length === 0 && batchSummary == null) {
      setLastResult(null);
      localBatchSessionRef.current = null;
    }
  }, [batchItems.length, batchSummary, flowGeneration]);

  async function pickImages() {
    const startsNewDraft = hasStoredResult;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!mountedRef.current) {
      return;
    }

    if (!permission.granted) {
      showToast("请先允许访问相册，再选择聊天截图。", "info");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
      allowsMultipleSelection: true,
      orderedSelection: true,
      selectionLimit: startsNewDraft
        ? MAX_UPLOAD_ASSETS
        : MAX_UPLOAD_ASSETS - assets.length,
    });
    if (!mountedRef.current || result.canceled || result.assets.length === 0) {
      return;
    }

    if (startsNewDraft) {
      resetFlow();
      dispatchDraft({ type: "reset" });
      setLastResult(null);
      localBatchSessionRef.current = null;
    }
    dispatchDraft({
      type: "add-assets",
      assets: result.assets.map((asset) => ({
        uri: asset.uri,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
      })),
    });
  }

  function handleProgress(
    progress: UploadBatchProgress,
    submitToken: number,
    generation: number,
  ) {
    if (
      !canCommitSubmitResult(mountedRef, submitTokenRef, submitToken) ||
      !isFlowGenerationCurrent(generation)
    ) {
      return;
    }

    clearLoadingTimer(loadingTimerRef.current);
    loadingTimerRef.current = null;

    if (progress.status === "processing") {
      markBatchItemProcessing(progress.index);
      setLoadingText(`正在处理第 ${progress.position}/${progress.totalCount} 张…`);
      loadingTimerRef.current = setTimeout(() => {
        if (
          !canCommitSubmitResult(mountedRef, submitTokenRef, submitToken) ||
          !isFlowGenerationCurrent(generation)
        ) {
          return;
        }
        setLoadingText(`AI 正在整理第 ${progress.position}/${progress.totalCount} 张…`);
      }, 2000);
      return;
    }

    if (progress.status === "success") {
      recordBatchItemSuccess(progress.index, progress.response);
      return;
    }

    recordBatchItemFailure(progress.index, progress.reason);
  }

  async function processBatch(
    source: BatchSource,
    previousResult: UploadBatchResult | null,
  ) {
    if (
      runningRef.current ||
      !mountedRef.current ||
      !focusedRef.current
    ) {
      return;
    }

    runningRef.current = true;
    const submitToken = submitTokenRef.current + 1;
    submitTokenRef.current = submitToken;
    const focusEpoch = focusEpochRef.current;
    const mode: UploadBatchMode = previousResult?.mode ?? (isLocal ? "local" : "server");
    const serverUrl = previousResult
      ? previousResult.serverUrl
      : mode === "server"
        ? currentServerUrl
        : null;
    let generation = flowGeneration;

    if (!previousResult) {
      localBatchSessionRef.current = mode === "local" ? new LocalBatchContactSession() : null;
      generation = beginBatch({
        assets,
        note,
        mode,
        localBatchSession: localBatchSessionRef.current,
        serverUrl,
      });
    } else if (mode === "local" && !localBatchSessionRef.current) {
      localBatchSessionRef.current = localBatchSession;
    }

    try {
      clearLoadingTimer(loadingTimerRef.current);
      setLoading(true);
      setLoadingText("正在准备截图…");
      const session = localBatchSessionRef.current;
      const batchNoteForRun = previousResult ? batchNote : note;
      const result = await uploadScreenshotBatch({
        ...source,
        mode,
        note: batchNoteForRun,
        serverUrl,
        async uploadScreenshot(input) {
          try {
            return await uploadScreenshot({
              asset: input.asset,
              note: input.note,
              expectedTarget: mode === "local"
                ? { mode: "local" }
                : { mode: "server", serverUrl },
              ...(mode === "local" && session
                ? { localBatch: { session, index: input.index } }
                : {}),
            });
          } catch (error) {
            if (mode === "local") {
              throw new Error(humanizeLocalProviderError(error));
            }
            throw error;
          }
        },
        onProgress: (progress) => handleProgress(progress, submitToken, generation),
        shouldContinue: () => (
          canCommitSubmitResult(mountedRef, submitTokenRef, submitToken) &&
          isFlowGenerationCurrent(generation)
        ),
      });

      if (
        !canCommitSubmitResult(mountedRef, submitTokenRef, submitToken) ||
        !isFlowGenerationCurrent(generation)
      ) {
        return;
      }

      finishBatch(result);
      const combined = previousResult ? mergeUploadBatchResults(previousResult, result) : result;
      setLastResult(combined);

      if (combined.failureCount === 0) {
        dispatchDraft({ type: "reset" });
        if (shouldAutoOpenUploadReview({
          focused: focusedRef.current,
          currentFocusEpoch: focusEpochRef.current,
          submitFocusEpoch: focusEpoch,
        })) {
          openReview(combined);
        }
      } else if (combined.successCount === 0) {
        showToast("这批截图暂时都没处理成功，可以只重试失败项。", "error");
      } else {
        showToast(`已处理 ${combined.successCount} 张，另有 ${combined.failureCount} 张可以重试。`, "info");
      }
    } catch (error) {
      if (
        !canCommitSubmitResult(mountedRef, submitTokenRef, submitToken) ||
        !isFlowGenerationCurrent(generation)
      ) {
        return;
      }
      showError(error, "这批截图暂时没有处理完成。");
    } finally {
      runningRef.current = false;
      clearLoadingTimer(loadingTimerRef.current);
      loadingTimerRef.current = null;
      if (mountedRef.current) {
        setLoading(false);
        setLoadingText("正在准备截图…");
      }
    }
  }

  function openReview(result: UploadBatchResult) {
    if (!uploadBatchTargetMatches({
      batchMode: result.mode,
      batchServerUrl: result.serverUrl,
      currentMode,
      currentServerUrl,
    })) {
      showToast("请先切回这批截图使用的处理模式与服务地址，再继续确认。", "info");
      return;
    }

    const firstSuccess = result.items.find(
      (item): item is UploadBatchSuccessItem => item.status === "success",
    );
    if (!firstSuccess) {
      showToast("这批截图还没有可确认的内容。", "info");
      return;
    }

    router.push(`/review/${firstSuccess.response.screenshot_id}`);
  }

  function openCompletedTextReview() {
    if (!completedTextItem?.screenshotId) {
      showToast("这段文本还没有可确认的内容。", "info");
      return;
    }

    if (targetMismatch) {
      showToast("请先切回这段文本使用的处理模式与服务地址，再继续确认。", "info");
      return;
    }

    router.push(`/review/${completedTextItem.screenshotId}`);
  }

  async function submit() {
    if (pastedText.trim()) {
      await processText();
      return;
    }

    if (assets.length === 0) {
      showToast("先选择聊天截图，或粘贴一段聊天文本。", "info");
      return;
    }

    await processBatch({ assets }, null);
  }

  async function processText() {
    const text = pastedText.trim();
    if (
      !text ||
      runningRef.current ||
      !mountedRef.current ||
      !focusedRef.current
    ) {
      return;
    }

    runningRef.current = true;
    const submitToken = submitTokenRef.current + 1;
    submitTokenRef.current = submitToken;
    const focusEpoch = focusEpochRef.current;
    const mode: UploadBatchMode = isLocal ? "local" : "server";
    const serverUrl = mode === "server" ? currentServerUrl : null;
    const generation = beginTextUpload({ mode, serverUrl, note });

    try {
      clearLoadingTimer(loadingTimerRef.current);
      setLoading(true);
      setLoadingText("正在整理粘贴文本…");
      const response = await uploadText({
        text,
        note: note.trim() || undefined,
        expectedTarget: mode === "local"
          ? { mode: "local" }
          : { mode: "server", serverUrl },
      });

      if (
        !canCommitSubmitResult(mountedRef, submitTokenRef, submitToken) ||
        !isFlowGenerationCurrent(generation)
      ) {
        return;
      }

      seedFromUpload(response, {
        label: "粘贴文本",
        mode,
        serverUrl,
        note,
      });
      dispatchDraft({ type: "reset" });
      setLastResult(null);

      if (shouldAutoOpenUploadReview({
        focused: focusedRef.current,
        currentFocusEpoch: focusEpochRef.current,
        submitFocusEpoch: focusEpoch,
      })) {
        router.push(`/review/${response.screenshot_id}`);
      }
    } catch (error) {
      if (
        !canCommitSubmitResult(mountedRef, submitTokenRef, submitToken) ||
        !isFlowGenerationCurrent(generation)
      ) {
        return;
      }
      showError(
        mode === "local" ? new Error(humanizeLocalProviderError(error)) : error,
        "这段文本暂时没有处理完成。",
      );
      recordBatchItemFailure(0, "这段文本暂时没有处理完成。");
    } finally {
      runningRef.current = false;
      clearLoadingTimer(loadingTimerRef.current);
      loadingTimerRef.current = null;
      if (mountedRef.current) {
        setLoading(false);
        setLoadingText("正在准备截图…");
      }
    }
  }

  function startTextDraft() {
    resetFlow();
    dispatchDraft({ type: "reset" });
    setLastResult(null);
    localBatchSessionRef.current = null;
  }

  async function retryFailures() {
    if (!displayResult) {
      return;
    }

    if (!uploadBatchTargetMatches({
      batchMode: displayResult.mode,
      batchServerUrl: displayResult.serverUrl,
      currentMode,
      currentServerUrl,
    })) {
      showToast("请先切回这批截图使用的处理模式与服务地址，再重试失败项。", "info");
      return;
    }

    await processBatch({ items: getFailedUploadItems(displayResult) }, displayResult);
  }

  function removeAsset(index: number) {
    if (hasStoredResult) {
      return;
    }

    setLastResult(null);
    localBatchSessionRef.current = null;
    dispatchDraft({ type: "remove-asset", index });
  }

  const footer = (
    <View style={styles.footerContent}>
      {assets.length > 0 || displayResult ? (
        <Text style={styles.costText}>
          共 {displayResult?.totalCount ?? assets.length} 张；每张需要一次模型调用，将按选择顺序逐张处理。
        </Text>
      ) : completedTextItem ? (
        <Text style={styles.costText}>粘贴文本已整理完成，可以继续确认生成的卡片。</Text>
      ) : pastedText.trim() ? (
        <Text style={styles.costText}>粘贴文本会直接交给文本模型整理，不会上传图片。</Text>
      ) : null}
      {displayResult?.failureCount ? (
        <AppButton
          label={targetMismatch ? "切回本批次目标后重试" : `只重试失败的 ${displayResult.failureCount} 张`}
          disabled={loading || targetMismatch}
          onPress={() => void retryFailures()}
        />
      ) : displayResult?.successCount ? (
        <AppButton
          label={targetMismatch ? "切回本批次目标后确认" : "查看待确认卡片"}
          disabled={loading || targetMismatch}
          onPress={() => openReview(displayResult)}
        />
      ) : completedTextItem ? (
        <AppButton
          label={targetMismatch ? "切回本次处理目标后确认" : "查看待确认卡片"}
          disabled={loading || targetMismatch}
          onPress={openCompletedTextReview}
        />
      ) : (
        <AppButton
          label={loading ? "处理中..." : "提交并开始整理"}
          disabled={loading || (assets.length === 0 && !pastedText.trim())}
          onPress={() => void submit()}
        />
      )}
      {displayResult && displayResult.successCount > 0 && displayResult.failureCount > 0 ? (
        <AppButton
          label="先确认已成功的截图"
          disabled={loading || targetMismatch}
          onPress={() => openReview(displayResult)}
          tone="secondary"
        />
      ) : null}
    </View>
  );

  return (
    <View style={styles.screen}>
      <Page
        title="整理聊天内容"
        subtitle={
          isLocal
            ? "可以按顺序选择多张聊天截图，也可以直接粘贴聊天文本。档案只会保存在这台手机上。"
            : "可以按顺序选择多张聊天截图，也可以直接粘贴聊天文本。处理完成后会进入卡片确认页。"
        }
        footer={footer}
      >
        <SectionCard kicker="上传后会发生什么" title="这次会整理什么">
          <MetaLine label="选图" value={`最多 ${MAX_UPLOAD_ASSETS} 张，系统严格按相册里的选择顺序处理。`} />
          <MetaLine label="文本" value="也可以直接粘贴一段聊天文字，不必先截图。" />
          <MetaLine label="下一步" value="整理出的卡片会按来源分组，逐条等待确认。" />
        </SectionCard>

        {displayMode === "server" ? (
          <SectionCard title="服务器模式说明">
            <Text style={styles.serverNote}>
              截图会逐张独立整理；同一联系人跨截图时，可能出现多张待确认卡片。粘贴文本按单条内容处理。
            </Text>
          </SectionCard>
        ) : null}

        {targetMismatch ? (
          <SectionCard title="处理目标已变更">
            <Text style={styles.serverNote}>
              这次内容仍保留在原来的处理模式与服务地址中。切回原目标后可以继续重试或确认；也可以重新选择来源开始整理。
            </Text>
          </SectionCard>
        ) : null}

        <SectionCard title={`聊天截图${assets.length ? `（${assets.length}/${MAX_UPLOAD_ASSETS}）` : ""}`}>
          {assets.length > 0 ? (
            <View style={styles.previewList}>
              {assets.map((asset, index) => (
                <View key={`${asset.uri}-${index}`} style={styles.previewRow}>
                  <Image source={{ uri: asset.uri }} style={styles.previewImage} />
                  <View style={styles.previewCopy}>
                    <Text style={styles.previewIndex}>第 {index + 1} 张</Text>
                    <Text numberOfLines={2} style={styles.previewName}>{getUploadAssetLabel(asset)}</Text>
                  </View>
                  <AppButton
                    disabled={loading || hasStoredResult}
                    label="移除"
                    onPress={() => removeAsset(index)}
                    style={styles.removeButton}
                    tone="secondary"
                  />
                </View>
              ))}
              {hasStoredResult ? (
                <AppButton
                  disabled={loading}
                  label="开始新一批"
                  onPress={() => void pickImages()}
                  tone="secondary"
                />
              ) : assets.length < MAX_UPLOAD_ASSETS ? (
                <AppButton
                  disabled={loading}
                  label="继续选择"
                  onPress={() => void pickImages()}
                  tone="secondary"
                />
              ) : null}
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => void pickImages()}
              style={({ pressed }) => [styles.pickBox, pressed ? styles.pickPressed : null]}
            >
              <Text style={styles.pickTitle}>从相册选截图</Text>
              <Text style={styles.pickText}>最多选择 20 张；选中的先后顺序就是处理顺序。</Text>
            </Pressable>
          )}
        </SectionCard>

        <SectionCard title="粘贴聊天文本">
          {hasStoredResult ? (
            <AppButton
              disabled={loading}
              label="改为整理一段新文本"
              onPress={startTextDraft}
              tone="secondary"
            />
          ) : (
            <TextInput
              editable={!loading}
              multiline
              onChangeText={(value) => dispatchDraft({ type: "set-text", text: value })}
              placeholder="长按粘贴群通知、会议安排或聊天片段。"
              placeholderTextColor={theme.colors.textMuted}
              style={styles.input}
              value={pastedText}
            />
          )}
          <Text style={styles.helperText}>
            输入文本后会自动清空已选图片；重新选图也会清空文本，避免两种来源混在一起。
          </Text>
        </SectionCard>

        <SectionCard title="补充说明（可选）">
          <TextInput
            editable={!loading && !hasStoredResult}
            multiline
            onChangeText={(value) => dispatchDraft({ type: "set-note", note: value })}
            placeholder="例如：这是我和陈老师最近三天的聊天，重点看会议时间和他的新公司。"
            placeholderTextColor={theme.colors.textMuted}
            style={styles.input}
            value={displayNote}
          />
          <Text style={styles.helperText}>不写也可以；这段说明只用于补充背景，不会覆盖截图或粘贴文本里的内容。</Text>
        </SectionCard>

        {displayResult ? (
          <SectionCard title="批次处理结果">
            <MetaLine label="成功" value={`${displayResult.successCount} 张`} />
            <MetaLine label="失败" value={`${displayResult.failureCount} 张`} />
            {getFailedUploadItems(displayResult).map((item) => (
              <View key={`${item.index}-${item.fileName}`} style={styles.failureRow}>
                <Text style={styles.failureName}>{item.fileName}</Text>
                <Text style={styles.failureReason}>{item.reason}</Text>
              </View>
            ))}
          </SectionCard>
        ) : null}

        {assets.length === 0 && !pastedText.trim() && !hasStoredResult ? (
          <EmptyHint text="先选择一张或多张截图，或粘贴聊天文本，再开始整理。" />
        ) : null}
      </Page>

      {loading ? (
        <View style={styles.overlay}>
          <View style={styles.overlayCard}>
            <ActivityIndicator color={theme.colors.primary} size="large" />
            <Text style={styles.overlayText}>{loadingText}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function buildFlowBatchResult(
  items: FlowBatchItem[],
  summary: FlowBatchSummary | null,
  mode: UploadBatchMode | null,
  serverUrl: string | null,
): UploadBatchResult | null {
  if (!summary || !mode || items.some((item) => item.asset == null)) {
    return null;
  }

  const resultItems: UploadBatchItem[] = items.map((item) => {
    if (item.status === "success" && item.screenshotId != null) {
      return {
        asset: item.asset!,
        fileName: item.label,
        index: item.index,
        status: "success",
        response: {
          screenshot_id: item.screenshotId,
          cards: item.cards,
          ...(item.processingNotice ? { processing_notice: item.processingNotice } : {}),
        },
      };
    }

    return {
      asset: item.asset!,
      fileName: item.label,
      index: item.index,
      status: "failure",
      reason: item.error ?? "处理失败，请稍后重试。",
    };
  });

  return {
    mode,
    serverUrl: mode === "server" ? serverUrl : null,
    status: summary.status,
    totalCount: summary.totalCount,
    successCount: summary.successCount,
    failureCount: summary.failureCount,
    items: resultItems,
  };
}

function clearLoadingTimer(timer: ReturnType<typeof setTimeout> | null) {
  if (timer) {
    clearTimeout(timer);
  }
}

function canCommitSubmitResult(
  mountedRef: { current: boolean },
  submitTokenRef: { current: number },
  submitToken: number,
) {
  return canCommitUploadCompletion({
    mounted: mountedRef.current,
    currentSubmitToken: submitTokenRef.current,
    submitToken,
  });
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: theme.colors.background,
    flex: 1,
  },
  footerContent: {
    gap: 10,
  },
  costText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
  },
  serverNote: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  previewList: {
    gap: 12,
  },
  previewRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  previewImage: {
    backgroundColor: theme.colors.surfaceMuted,
    borderRadius: 12,
    height: 68,
    width: 68,
  },
  previewCopy: {
    flex: 1,
    gap: 4,
  },
  previewIndex: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "700",
  },
  previewName: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  removeButton: {
    minHeight: 40,
    width: 76,
  },
  pickBox: {
    alignItems: "center",
    backgroundColor: theme.colors.primarySoft,
    borderColor: theme.colors.primaryBorder,
    borderRadius: 22,
    borderStyle: "dashed",
    borderWidth: 1,
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 28,
  },
  pickPressed: {
    opacity: 0.9,
  },
  pickTitle: {
    color: theme.colors.primary,
    fontSize: 16,
    fontWeight: "800",
  },
  pickText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  input: {
    backgroundColor: theme.colors.surfaceMuted,
    borderColor: theme.colors.border,
    borderRadius: 16,
    borderWidth: 1,
    color: theme.colors.textPrimary,
    fontSize: 15,
    lineHeight: 22,
    minHeight: 120,
    padding: 14,
    textAlignVertical: "top",
  },
  helperText: {
    color: theme.colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  failureRow: {
    backgroundColor: theme.colors.surfaceMuted,
    borderRadius: 14,
    gap: 4,
    padding: 12,
  },
  failureName: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: "700",
  },
  failureReason: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  overlay: {
    alignItems: "center",
    backgroundColor: "rgba(20, 33, 26, 0.22)",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  overlayCard: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: 24,
    gap: 14,
    minWidth: 240,
    paddingHorizontal: 28,
    paddingVertical: 26,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
  },
  overlayText: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: "700",
  },
});
