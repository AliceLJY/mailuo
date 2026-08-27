import { Redirect, Tabs, router } from "expo-router";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { useConnection } from "@/connection/context";
import { resolveStartupDestination } from "@/connection/startup";
import { theme } from "@/theme";

export default function TabLayout() {
  const { config, loading } = useConnection();

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={theme.colors.primary} />
        <Text style={styles.loadingText}>正在打开脉络…</Text>
      </View>
    );
  }

  const platform = Platform.OS === "web" ? "web" : Platform.OS === "ios" ? "ios" : "android";
  const destination = resolveStartupDestination(
    config,
    platform,
    process.env.EXPO_PUBLIC_API_URL,
  );

  if (destination === "guide") {
    return <Redirect href="/connection" />;
  }

  if (destination === "server-form") {
    return <Redirect href="/connection/server" />;
  }

  return (
    <Tabs
      screenOptions={{
        headerShadowVisible: false,
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.textPrimary,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "上传",
          tabBarLabel: "上传",
          headerRight: () => (
            <Pressable
              accessibilityLabel="打开设置"
              accessibilityRole="button"
              onPress={() => router.push("/settings")}
              style={styles.settingsButton}
            >
              <Text style={styles.settingsIcon}>⚙︎</Text>
            </Pressable>
          ),
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: "人脉",
          tabBarLabel: "人脉",
        }}
      />
      <Tabs.Screen
        name="meetings"
        options={{
          title: "日程",
          tabBarLabel: "日程",
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: "center",
    backgroundColor: theme.colors.background,
    flex: 1,
    gap: 12,
    justifyContent: "center",
  },
  loadingText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
  },
  settingsButton: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    marginRight: 8,
    width: 40,
  },
  settingsIcon: {
    color: theme.colors.textPrimary,
    fontSize: 24,
  },
});
