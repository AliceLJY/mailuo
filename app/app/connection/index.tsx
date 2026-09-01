import { router } from "expo-router";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { Page } from "@/components/page";
import { theme } from "@/theme";

export default function ConnectionGuideScreen() {
  const isWeb = Platform.OS === "web";

  return (
    <Page
      title="选择脉络的使用方式"
      subtitle="选一种适合你的方式，之后也能随时在设置里更换。"
    >
      {!isWeb ? (
        <ModeCard
          description="填入 Key 后，档案只保存在这台手机上；整理时会直接连接模型服务商。"
          onPress={() => router.push("/connection/local")}
          title="我有模型 API Key"
        />
      ) : null}

      <ModeCard
        description="连接你自建的脉络后端。"
        onPress={() => router.push("/connection/server")}
        title="我有自己的服务器"
      />

      {!isWeb ? (
        <ModeCard
          badge="敬请期待"
          description="由脉络提供服务，目前还不能选择。"
          disabled
          title="订阅服务"
        />
      ) : null}
    </Page>
  );
}

function ModeCard({
  badge,
  description,
  disabled = false,
  onPress,
  title,
}: {
  badge?: string;
  description: string;
  disabled?: boolean;
  onPress?: () => void;
  title: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        disabled ? styles.disabledCard : null,
        pressed && !disabled ? styles.pressedCard : null,
      ]}
    >
      <View style={styles.titleRow}>
        <Text style={[styles.title, disabled ? styles.disabledText : null]}>{title}</Text>
        {badge ? <Text style={styles.badge}>{badge}</Text> : null}
      </View>
      <Text style={[styles.description, disabled ? styles.disabledText : null]}>
        {description}
      </Text>
      {!disabled ? <Text style={styles.action}>选择这个方式</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderRadius: 22,
    borderWidth: 1,
    gap: 10,
    padding: 20,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.05,
    shadowRadius: 18,
  },
  disabledCard: {
    backgroundColor: "#EEF2EF",
    opacity: 0.72,
  },
  pressedCard: {
    borderColor: theme.colors.primary,
    opacity: 0.88,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  title: {
    color: theme.colors.textPrimary,
    flex: 1,
    fontSize: 19,
    fontWeight: "800",
  },
  description: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  action: {
    color: theme.colors.primary,
    fontSize: 14,
    fontWeight: "700",
  },
  disabledText: {
    color: theme.colors.textMuted,
  },
  badge: {
    backgroundColor: "#DDE4DF",
    borderRadius: 999,
    color: theme.colors.textMuted,
    fontSize: 11,
    fontWeight: "700",
    overflow: "hidden",
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
});
