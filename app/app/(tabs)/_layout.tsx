import { Tabs } from "expo-router";

import { theme } from "@/theme";

export default function TabLayout() {
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
