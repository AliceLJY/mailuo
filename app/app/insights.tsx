import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";

import { getContactDetail, getErrorMessage } from "@/api";
import { AppButton } from "@/components/button";
import { InsightCard } from "@/components/insight/insight-card";
import { EmptyHint, Page, SectionCard } from "@/components/page";
import { useFlow } from "@/flow-context";
import { useToast } from "@/toast-context";

function uniqueIds(values: number[]) {
  return [...new Set(values)];
}

export default function InsightsScreen() {
  const [pageError, setPageError] = useState<string | null>(null);
  const {
    affectedContactIds,
    contactDetailsById,
    evidenceById,
    hasInsightFailure,
    insights,
    mergeContactDetail,
    resetFlow,
  } = useFlow();
  const { showError } = useToast();
  const targetContactIds = useMemo(
    () => uniqueIds([...affectedContactIds, ...insights.map((item) => item.contact_id)]),
    [affectedContactIds, insights],
  );

  useEffect(() => {
    const missingIds = targetContactIds.filter((contactId) => !contactDetailsById[contactId]);

    if (!missingIds.length) {
      return;
    }

    void (async () => {
      const results = await Promise.allSettled(missingIds.map((contactId) => getContactDetail(contactId)));
      const failed = results.some((item) => item.status === "rejected");

      for (const result of results) {
        if (result.status === "fulfilled") {
          mergeContactDetail(result.value);
        }
      }

      if (failed) {
        const message = "有些联系人证据还没补齐，稍后再试一次。";
        setPageError(message);
        showError(new Error(message), message);
      } else {
        setPageError(null);
      }
    })();
  }, [contactDetailsById, mergeContactDetail, showError, targetContactIds]);

  return (
    <Page
      title="洞察结果"
      subtitle="这里只聚合本轮确认动作返回的 insights，并把 based_on 映射回 observation 内容。"
      footer={
        <AppButton
          label="回上传继续"
          onPress={() => {
            resetFlow();
            router.replace("/");
          }}
        />
      }
    >
      {hasInsightFailure ? (
        <SectionCard title="提示">
          <EmptyHint text="洞察生成没成功，档案已保存，下次确认时会再生成" />
        </SectionCard>
      ) : null}

      {pageError ? (
        <SectionCard title="证据补全提醒">
          <EmptyHint text={pageError} />
        </SectionCard>
      ) : null}

      {!insights.length ? (
        <SectionCard title="暂时没有新洞察">
          <EmptyHint text="这轮没有可展示的新洞察。你可以回上传继续下一张截图，或稍后在人脉页查看已更新的档案。" />
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
