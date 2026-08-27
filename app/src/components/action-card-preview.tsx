import { Pressable, StyleSheet, Text, View } from "react-native";

import { getConfidenceColor, theme } from "@/theme";
import type { ActionCardRecord } from "@/types";

type Props = {
  card: ActionCardRecord;
  compact?: boolean;
  onPressSource?: () => void;
};

const cardTypeLabel: Record<ActionCardRecord["type"], string> = {
  create_contact: "新联系人",
  update_contact: "更新联系人",
  create_meeting: "新会议",
  record_interaction: "互动记录",
};

const statusLabel: Record<ActionCardRecord["status"], string> = {
  pending: "待确认",
  confirmed: "已确认",
  rejected: "已跳过",
};

const confidenceLabel: Record<ActionCardRecord["confidence"], string> = {
  high: "高把握",
  medium: "中等把握",
  low: "待确认",
};

const fieldLabel: Record<string, string> = {
  company: "公司",
  title: "职位",
  phone: "电话",
  wechat_id: "微信号",
  notes: "备注",
};

export function ActionCardPreview({ card, compact = false, onPressSource }: Props) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View>
          <Text style={styles.type}>{cardTypeLabel[card.type]}</Text>
          <Text style={styles.status}>状态：{statusLabel[card.status]}</Text>
        </View>
        <View
          style={[
            styles.badge,
            { backgroundColor: `${getConfidenceColor(card.confidence)}1A` },
          ]}
        >
          <View
            style={[
              styles.dot,
              { backgroundColor: getConfidenceColor(card.confidence) },
            ]}
          />
          <Text style={styles.badgeText}>{confidenceLabel[card.confidence]}</Text>
        </View>
      </View>

      <Text style={styles.summary}>{summarizeCard(card)}</Text>

      {card.disambiguation?.candidates?.length ? (
        <Text style={styles.meta}>
          待裁决候选：{card.disambiguation.candidates.map(formatCandidate).join("、")}
        </Text>
      ) : null}

      {!compact ? (
        <Pressable onPress={onPressSource} style={styles.quoteBox}>
          <Text style={styles.quoteTitle}>依据原文</Text>
          <Text style={styles.quoteText}>{card.source_quote}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function summarizeCard(card: ActionCardRecord) {
  if (card.type === "create_contact") {
    const company = card.payload.company ? ` · ${card.payload.company}` : "";
    return `${card.payload.name}${company}`;
  }

  if (card.type === "update_contact") {
    const fields = Object.entries(card.payload.changes)
      .map(([field, value]) => `${fieldLabel[field] ?? field}：${value.old ?? "未填写"} → ${value.new}`)
      .join("；");
    return `${card.payload.contact_name}：${fields}`;
  }

  if (card.type === "create_meeting") {
    return `${card.payload.title} · ${card.payload.time_text}`;
  }

  return `${card.payload.contact_name}：${card.payload.summary}`;
}

function formatCandidate(candidate: {
  name: string;
  company?: string | null;
}) {
  return candidate.company ? `${candidate.name}（${candidate.company}）` : candidate.name;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surfaceMuted,
    borderColor: theme.colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 14,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  type: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: "700",
  },
  status: {
    color: theme.colors.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
  badge: {
    alignItems: "center",
    borderRadius: 999,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  badgeText: {
    color: theme.colors.textPrimary,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  summary: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  meta: {
    color: theme.colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  quoteBox: {
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    gap: 6,
    paddingTop: 10,
  },
  quoteTitle: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
  },
  quoteText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
});
