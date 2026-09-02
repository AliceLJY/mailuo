import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, View } from "react-native";

import { getConfiguredApiUrl, getContactDetail, getErrorMessage } from "@/api";
import { AppButton } from "@/components/button";
import { InsightCard } from "@/components/insight/insight-card";
import { EmptyHint, Page, SectionCard } from "@/components/page";
import { useConnection } from "@/connection/context";
import { logEvent } from "@/diagnostics/event-log";
import { useFlow } from "@/flow-context";
import { useToast } from "@/toast-context";
import {
  normalizeUploadServerUrl,
  uploadBatchTargetMatches,
} from "@/upload-batch";

function uniqueIds(values: number[]) {
  return [...new Set(values)];
}

export default function InsightsScreen() {
  const [pageError, setPageError] = useState<string | null>(null);
  const {
    affectedContactIds,
    batchMode,
    batchServerUrl,
    contactDetailsById,
    evidenceById,
    flowGeneration,
    hasInsightFailure,
    insights,
    isFlowGenerationCurrent,
    mergeContactDetail,
    processingNotice,
    resetFlow,
  } = useFlow();
  const { showError } = useToast();
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
  const loadRunTokenRef = useRef(0);
  const representedLoadKeysRef = useRef(new Set<string>());
  const targetContactIds = useMemo(
    () => uniqueIds([...affectedContactIds, ...insights.map((item) => item.contact_id)]),
    [affectedContactIds, insights],
  );

  useEffect(() => {
    const requestGeneration = flowGeneration;
    const runToken = loadRunTokenRef.current + 1;
    loadRunTokenRef.current = runToken;
    const missingIds = targetMismatch
      ? []
      : targetContactIds.filter((contactId) => !contactDetailsById[contactId]);
    const loadKey = `${flowGeneration}:${targetContactIds.join(",")}`;

    if (!missingIds.length) {
      if (!targetMismatch && !representedLoadKeysRef.current.has(loadKey)) {
        representedLoadKeysRef.current.add(loadKey);
        logEvent(
          "insights_start",
          `contacts=${targetContactIds.length},missing=0`,
        );
        logEvent(
          "insights_ok",
          `contacts=${targetContactIds.length},missing=0`,
        );
      }
      return;
    }

    logEvent(
      "insights_start",
      `contacts=${targetContactIds.length},missing=${missingIds.length}`,
    );

    let active = true;

    void (async () => {
      const results = await Promise.allSettled(missingIds.map((contactId) => getContactDetail(contactId)));
      if (
        !active ||
        loadRunTokenRef.current !== runToken ||
        !isFlowGenerationCurrent(requestGeneration)
      ) {
        return;
      }

      const failed = results.some((item) => item.status === "rejected");

      for (const result of results) {
        if (result.status === "fulfilled") {
          mergeContactDetail(result.value);
        }
      }
      representedLoadKeysRef.current.add(loadKey);

      if (failed) {
        const failureCount = results.filter((item) => item.status === "rejected").length;
        logEvent(
          "insights_error",
          `contacts=${targetContactIds.length},failed=${failureCount}`,
        );
        const message = "有些联系人的依据还没补齐，稍后再试一次。";
        setPageError(message);
        showError(new Error(message), message);
      } else {
        logEvent("insights_ok", `contacts=${targetContactIds.length},missing=${missingIds.length}`);
        setPageError(null);
      }
    })();

    return () => {
      active = false;
      if (loadRunTokenRef.current === runToken) {
        loadRunTokenRef.current += 1;
      }
    };
  }, [
    contactDetailsById,
    flowGeneration,
    isFlowGenerationCurrent,
    mergeContactDetail,
    targetMismatch,
    showError,
    targetContactIds,
  ]);

  return (
    <Page
      title="洞察结果"
      subtitle="这里会汇总这次确认后整理出的洞察，并附上对应依据。"
      footer={
        <View style={styles.footerActions}>
          <AppButton
            label="完成"
            onPress={() => {
              resetFlow();
              router.replace("/meetings");
            }}
          />
          <AppButton
            label="继续整理下一批"
            onPress={() => {
              resetFlow();
              router.replace("/");
            }}
            tone="secondary"
          />
        </View>
      }
    >
      {processingNotice ? (
        <SectionCard title="处理提示">
          <EmptyHint text={processingNotice} />
        </SectionCard>
      ) : null}

      {targetMismatch ? (
        <SectionCard title="处理目标已变更">
          <EmptyHint text="这批洞察属于原来的处理模式与服务地址。切回原目标后再查看依据，避免读取另一套档案。" />
        </SectionCard>
      ) : null}

      {hasInsightFailure ? (
        <SectionCard title="提示">
          <EmptyHint text="这次洞察暂时没生成，但档案已经保存。" />
        </SectionCard>
      ) : null}

      {pageError ? (
        <SectionCard title="依据补充中">
          <EmptyHint text={pageError} />
        </SectionCard>
      ) : null}

      {!insights.length ? (
        <SectionCard title="暂时没有新洞察">
          <EmptyHint text="这次还没有新的洞察。你可以继续整理下一批内容，或稍后在人脉页查看更新后的档案。" />
        </SectionCard>
      ) : null}

      {insights.map((insight) => (
        <InsightCard
          key={insight.id}
          contactName={contactDetailsById[insight.contact_id]?.contact.canonical_name}
          evidence={insight.based_on.map((id) => evidenceById[id]).filter(Boolean)}
          insight={insight}
        />
      ))}
    </Page>
  );
}

const styles = StyleSheet.create({
  footerActions: {
    flexDirection: "column",
    gap: 10,
  },
});
