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
        const message = "有些联系人的依据还没补齐，稍后再试一次。";
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
      subtitle="这里会汇总这次确认后整理出的洞察，并附上对应依据。"
      footer={
        <AppButton
          label="继续上传下一张"
          onPress={() => {
            resetFlow();
            router.replace("/");
          }}
        />
      }
    >
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
          <EmptyHint text="这次还没有新的洞察。你可以继续上传下一张截图，或稍后在人脉页查看更新后的档案。" />
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
