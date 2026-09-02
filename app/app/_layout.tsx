import Constants from "expo-constants";
import { router, Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CrashBoundary } from "@/components/crash-boundary";
import { ConnectionProvider, useConnection } from "@/connection/context";
import {
  installGlobalCrashHandler,
  setCrashContext,
} from "@/diagnostics/crash-record";
import { crashStorage } from "@/diagnostics/crash-storage";
import { FlowProvider } from "@/flow-context";
import { theme } from "@/theme";
import { ToastProvider } from "@/toast-context";

setCrashContext({ appVersion: Constants.expoConfig?.version ?? "unknown" });
installGlobalCrashHandler(crashStorage);

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ToastProvider>
        <ConnectionProvider>
          <FlowProvider>
            <AppStack />
          </FlowProvider>
        </ConnectionProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

function AppStack() {
  const pathname = usePathname();
  const { config } = useConnection();

  // Set synchronously so a child render failure captures the route being rendered.
  setCrashContext({
    currentRoute: pathname,
    exportOcrResults: config?.exportOcrResults === true,
  });

  return (
    <>
      <StatusBar style="dark" />
      <CrashBoundary
        onReturnHome={() => router.replace("/")}
        storage={crashStorage}
      >
        <Stack
          screenOptions={{
            contentStyle: { backgroundColor: theme.colors.background },
            headerShadowVisible: false,
            headerStyle: { backgroundColor: theme.colors.surface },
            headerTintColor: theme.colors.textPrimary,
            headerTitleStyle: { fontWeight: "700" },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="connection/index" options={{ headerShown: false }} />
          <Stack.Screen name="connection/local" options={{ title: "模型 Key" }} />
          <Stack.Screen name="connection/server" options={{ title: "服务器" }} />
          <Stack.Screen name="settings" options={{ title: "设置" }} />
          <Stack.Screen name="review/[screenshotId]" options={{ title: "确认卡片" }} />
          <Stack.Screen name="insights" options={{ title: "洞察结果" }} />
          <Stack.Screen name="contacts/[id]" options={{ title: "联系人详情" }} />
        </Stack>
      </CrashBoundary>
    </>
  );
}
