import { useState, type PropsWithChildren } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { theme } from "@/theme";

type Props = PropsWithChildren<{
  title: string;
  hint?: string;
  defaultOpen?: boolean;
}>;

export function DisclosurePanel({
  children,
  defaultOpen = false,
  hint,
  title,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <View style={styles.shell}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={styles.header}
      >
        <View style={styles.copy}>
          <Text style={styles.title}>{title}</Text>
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        </View>
        <Text style={styles.chevron}>{open ? "收起" : "展开"}</Text>
      </Pressable>
      {open ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    backgroundColor: theme.colors.surfaceMuted,
    borderColor: theme.colors.border,
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  hint: {
    color: theme.colors.textMuted,
    fontSize: 12,
  },
  chevron: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "700",
  },
  body: {
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    gap: 10,
    padding: 14,
  },
});
