import { StyleSheet, Text, View } from "react-native";

import { EmptyHint, SectionCard } from "@/components/page";
import { theme } from "@/theme";
import type { ObservationKind, ObservationRecord } from "@/types";

type Props = {
  observations: ObservationRecord[];
};

const observationMeta: Record<
  ObservationKind,
  { accent: string; label: string; marker: string }
> = {
  fact: { accent: "#DFF6E8", label: "事实", marker: "事" },
  preference: { accent: "#FFF0D8", label: "偏好", marker: "偏" },
  status_change: { accent: "#E8EEFF", label: "状态变化", marker: "变" },
  interaction: { accent: "#F0EBFF", label: "互动", marker: "互" },
};

export function ContactObservationTimeline({ observations }: Props) {
  return (
    <SectionCard title="观测时间线" kicker={`${observations.length} 条观测`}>
      {observations.length === 0 ? <EmptyHint text="还没有观测记录。" /> : null}

      {observations.map((item) => {
        const meta = observationMeta[item.kind];

        return (
          <View key={item.id} style={styles.item}>
            <View style={[styles.marker, { backgroundColor: meta.accent }]}>
              <Text style={styles.markerText}>{meta.marker}</Text>
            </View>

            <View style={styles.body}>
              <View style={styles.row}>
                <Text style={styles.kind}>{meta.label}</Text>
                <Text style={styles.time}>{formatDateTime(item.observed_at)}</Text>
              </View>

              <Text style={styles.content}>{item.content}</Text>

              {item.source_quote ? (
                <View style={styles.quoteBox}>
                  <Text style={styles.quoteLabel}>依据原文</Text>
                  <Text style={styles.quoteText}>{item.source_quote}</Text>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
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
    flexDirection: "row",
    gap: 12,
  },
  marker: {
    alignItems: "center",
    borderRadius: 999,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  markerText: {
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: "800",
  },
  body: {
    borderBottomColor: theme.colors.border,
    borderBottomWidth: 1,
    flex: 1,
    gap: 8,
    paddingBottom: 14,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
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
  quoteBox: {
    backgroundColor: theme.colors.surfaceMuted,
    borderColor: theme.colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
    padding: 12,
  },
  quoteLabel: {
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
