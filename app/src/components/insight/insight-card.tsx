import { StyleSheet, Text, View } from "react-native";

import { DisclosurePanel } from "@/components/evidence/disclosure-panel";
import { getInsightLabel, getObservationLabel, theme } from "@/theme";
import type { InsightRecord, ObservationRecord } from "@/types";

type Props = {
  contactName?: string;
  evidence: ObservationRecord[];
  insight: InsightRecord;
};

const KIND_ICON = {
  relationship_read: "见",
  suggested_action: "做",
  conversation_hook: "聊",
} satisfies Record<InsightRecord["kind"], string>;

export function InsightCard({ contactName, evidence, insight }: Props) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.iconWrap}>
          <Text style={styles.icon}>{KIND_ICON[insight.kind]}</Text>
        </View>
        <View style={styles.copy}>
          <Text style={styles.label}>{getInsightLabel(insight.kind)}</Text>
          <Text style={styles.contact}>{contactName ?? `联系人 #${insight.contact_id}`}</Text>
        </View>
      </View>

      <Text style={styles.content}>{insight.content}</Text>

      <DisclosurePanel
        title="依据观测"
        hint={evidence.length ? `${evidence.length} 条` : "暂无映射到 observation 内容"}
      >
        {evidence.length ? (
          evidence.map((item) => (
            <View key={item.id} style={styles.evidenceRow}>
              <Text style={styles.evidenceKind}>{getObservationLabel(item.kind)}</Text>
              <Text style={styles.evidenceContent}>{item.content}</Text>
            </View>
          ))
        ) : (
          <Text style={styles.emptyText}>
            based_on 已返回，但当前还没有拿到对应 observation 详情。
          </Text>
        )}
      </DisclosurePanel>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderRadius: 22,
    borderWidth: 1,
    gap: 14,
    padding: 18,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  iconWrap: {
    alignItems: "center",
    backgroundColor: theme.colors.primarySoft,
    borderRadius: 16,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  icon: {
    color: theme.colors.primary,
    fontSize: 16,
    fontWeight: "800",
  },
  copy: {
    flex: 1,
    gap: 3,
  },
  label: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: "800",
  },
  contact: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
  },
  content: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    lineHeight: 23,
  },
  evidenceRow: {
    gap: 4,
  },
  evidenceKind: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
  },
  evidenceContent: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  emptyText: {
    color: theme.colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
});
