import Constants from "expo-constants";
import { router, Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { CrashBoundary } from "@/components/crash-boundary";
import { ConnectionProvider, useConnection } from "@/connection/context";
import {
  installGlobalCrashHandler,
  setCrashContext,
} from "@/diagnostics/crash-record";
import { crashStorage } from "@/diagnostics/crash-storage";
import {
  configureEventLogStorage,
  logEvent,
  startAppSession,
} from "@/diagnostics/event-log";
import {
  formatMemoryEventDetail,
  readHermesMemoryStats,
} from "@/diagnostics/memory-stats";
import {
  formatExitReasonEventDetail,
  loadPreviousExitInfo,
} from "@/diagnostics/previous-exit";
import { installDeviceDiagnosticsTraceWriter } from "@/diagnostics/trace-runtime";
import { FlowProvider } from "@/flow-context";
import { theme } from "@/theme";
import { ToastProvider } from "@/toast-context";
import {
  readLastExitInfo,
  readMemoryStats,
} from "../modules/tenglu-region-sampler/src/TengluRegionSamplerModule";
import type { ExitInfo } from "../modules/tenglu-region-sampler/src/TengluRegionSampler.types";

configureEventLogStorage(crashStorage);
installDeviceDiagnosticsTraceWriter();
const previousSession = startAppSession();
const previousExitInfoPromise = loadPreviousExitInfo(
  { readLastExitInfo },
  previousSession,
  (info) => logEvent("exit_reason", formatExitReasonEventDetail(info)),
);
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
  const lastLoggedRouteRef = useRef<string | null>(null);
  const [previousExitInfo, setPreviousExitInfo] = useState<
    ExitInfo | null | undefined
  >(undefined);

  if (lastLoggedRouteRef.current !== pathname) {
    logEvent("route", pathname);
    const hermesStats = readHermesMemoryStats();
    void readMemoryStats()
      .then((nativeStats) => {
        logEvent(
          "mem",
          formatMemoryEventDetail(`route path=${pathname}`, nativeStats, hermesStats),
        );
      })
      .catch(() => {
        logEvent(
          "mem",
          formatMemoryEventDetail(`route path=${pathname}`, null, hermesStats),
        );
      });
    lastLoggedRouteRef.current = pathname;
  }

  // Set synchronously so a child render failure captures the route being rendered.
  setCrashContext({
    currentRoute: pathname,
    exportOcrResults: config?.exportOcrResults === true,
  });

  useEffect(() => {
    let active = true;
    void previousExitInfoPromise.then((info) => {
      if (active) {
        setPreviousExitInfo(info);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        logEvent("app_background");
      } else if (state === "active") {
        logEvent("app_active");
      }
    });

    return () => subscription.remove();
  }, []);

  return (
    <>
      <StatusBar style="dark" />
      <CrashBoundary
        onReturnHome={() => router.replace("/")}
        previousExitInfo={previousExitInfo}
        previousSession={previousSession}
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
