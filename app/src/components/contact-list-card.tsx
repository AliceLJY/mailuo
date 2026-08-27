import { Pressable, StyleSheet, Text, View } from "react-native";

import { theme } from "@/theme";
import type { ContactListItem } from "@/types";

type Props = {
  contact: ContactListItem;
  onPress: () => void;
};

export function ContactListCard({ contact, onPress }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed ? styles.pressed : null]}
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.name}>{contact.canonical_name}</Text>
          <Text style={styles.company}>{contact.company ?? "公司待补充"}</Text>
        </View>
        <View style={styles.countBadge}>
          <Text style={styles.countLabel}>记录 {contact.observation_count}</Text>
        </View>
      </View>

      <View style={styles.metaRow}>
        <Text style={styles.metaLabel}>最近互动</Text>
        <Text style={styles.metaValue}>
          {formatDateTime(contact.last_interaction_at) ?? "最近还没有互动"}
        </Text>
      </View>
    </Pressable>
  );
}

function formatDateTime(value: string | null) {
  if (!value) {
    return null;
  }

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
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderRadius: 22,
    borderWidth: 1,
    gap: 14,
    padding: 18,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 18,
  },
  pressed: {
    opacity: 0.88,
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  headerText: {
    flex: 1,
    gap: 6,
  },
  name: {
    color: theme.colors.textPrimary,
    fontSize: 19,
    fontWeight: "800",
  },
  company: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  countBadge: {
    backgroundColor: theme.colors.primarySoft,
    borderColor: theme.colors.primaryBorder,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  countLabel: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "700",
  },
  metaRow: {
    gap: 6,
  },
  metaLabel: {
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
  },
  metaValue: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
});
