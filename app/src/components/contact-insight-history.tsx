import { StyleSheet, Text, View } from "react-native";

import { EmptyHint, SectionCard } from "@/components/page";
import { getInsightLabel, theme } from "@/theme";
import type { InsightKind, InsightRecord } from "@/types";

type Props = {
  insights: InsightRecord[];
};

const insightMarkers: Record<InsightKind, string> = {
  relationship_read: "读",
  suggested_action: "行",
  conversation_hook: "聊",
};

export function ContactInsightHistory({ insights }: Props) {
  return (
    <SectionCard title="历史洞察" kicker={`${insights.length} 条记录`}>
      {insights.length === 0 ? <EmptyHint text="还没有历史洞察。" /> : null}

      {insights.map((item) => (
        <View key={item.id} style={styles.item}>
          <View style={styles.header}>
            <View style={styles.labelRow}>
              <View style={styles.marker}>
                <Text style={styles.markerText}>{insightMarkers[item.kind]}</Text>
              </View>
              <Text style={styles.kind}>{getInsightLabel(item.kind)}</Text>
            </View>
            <Text style={styles.time}>{formatDateTime(item.generated_at)}</Text>
          </View>

          <Text style={styles.content}>{item.content}</Text>

          <Text style={styles.meta}>
            {item.based_on.length > 0
              ? `依据 ${item.based_on.length} 条观测`
              : "未附观测编号"}
          </Text>
        </View>
      ))}
    </SectionCard>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "numeric",
  }).format(date);
}

const styles = StyleSheet.create({
  item: {
    borderBottomColor: theme.colors.border,
    borderBottomWidth: 1,
    gap: 8,
    paddingBottom: 14,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  labelRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
  },
  marker: {
    alignItems: "center",
    backgroundColor: theme.colors.primarySoft,
    borderRadius: 999,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  markerText: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "800",
  },
  kind: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  time: {
    color: theme.colors.textMuted,
    fontSize: 12,
  },
  content: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  meta: {
    color: theme.colors.textMuted,
    fontSize: 12,
  },
});
