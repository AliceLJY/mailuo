import { Component, type PropsWithChildren } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppButton } from "@/components/button";
import {
  clearCrashRecord,
  createCrashRecord,
  readCrashRecord,
  writeCrashRecord,
  type CrashRecord,
  type SyncCrashStorage,
} from "@/diagnostics/crash-record";
import {
  acknowledgePreviousSession,
  type EventLogEntry,
  type PreviousSessionSnapshot,
} from "@/diagnostics/event-log";
import {
  formatEventLogEntry,
  formatJavaCrashSummary,
  formatSavedExitTrace,
  formatSystemExitReason,
  getPreviousExitPanelCopy,
  getJavaCrashStackFrames,
  getRecentPreviousEvents,
  shouldShowPreviousExit,
} from "@/diagnostics/previous-exit";
import { theme } from "@/theme";
import type {
  ExitInfo,
  ExitTraceSaveResult,
  JavaCrashRecord,
} from "../../modules/tenglu-region-sampler/src/TengluRegionSampler.types";

type Props = PropsWithChildren<{
  storage: SyncCrashStorage;
  onReturnHome: () => void;
  previousExitDiagnosticsReady?: boolean;
  previousExitInfo?: ExitInfo | null;
  previousExitTrace?: ExitTraceSaveResult | null;
  previousJavaCrash?: JavaCrashRecord | null;
  previousSession?: PreviousSessionSnapshot | null;
}>;

type State = {
  activeError: Error | null;
  activeRecord: CrashRecord | null;
  previousDismissed: boolean;
  previousRecord: CrashRecord | null;
};

export class CrashBoundary extends Component<Props, State> {
  state: State = {
    activeError: null,
    activeRecord: null,
    previousDismissed: false,
    previousRecord: readCrashRecord(this.props.storage),
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { activeError: error, activeRecord: null };
  }

  componentDidCatch(error: Error) {
    const activeRecord = writeCrashRecord(this.props.storage, error, false);
    this.setState({ activeRecord });
  }

  private acknowledgePrevious = () => {
    clearCrashRecord(this.props.storage);
    acknowledgePreviousSession(
      this.props.storage,
      this.props.previousSession ?? null,
    );
    this.setState({ previousDismissed: true, previousRecord: null });
  };

  private returnHome = () => {
    this.props.onReturnHome();
    this.setState({ activeError: null, activeRecord: null });
  };

  render() {
    if (this.state.activeError) {
      const record = this.state.activeRecord ?? createCrashRecord(
        this.state.activeError,
        false,
      );
      return (
        <CrashPanel
          actionLabel="回到首页"
          heading="页面发生异常"
          intro="以下诊断信息已保存在本机。可以先截图，再继续使用。"
          onAction={this.returnHome}
          record={record}
        />
      );
    }

    if (
      !this.state.previousDismissed &&
      shouldShowPreviousExit(
        this.state.previousRecord,
        this.props.previousSession,
        this.props.previousJavaCrash,
      )
    ) {
      const copy = getPreviousExitPanelCopy(
        this.state.previousRecord !== null || this.props.previousJavaCrash != null,
      );
      return (
        <CrashPanel
          actionDisabled={this.props.previousExitDiagnosticsReady === false}
          actionLabel={
            this.props.previousExitDiagnosticsReady === false
              ? "正在读取诊断…"
              : "知道了"
          }
          events={getRecentPreviousEvents(this.props.previousSession)}
          heading={copy.heading}
          intro={copy.intro}
          onAction={this.acknowledgePrevious}
          previousExitInfo={this.props.previousExitInfo}
          previousExitTrace={this.props.previousExitTrace}
          previousJavaCrash={this.props.previousJavaCrash}
          record={this.state.previousRecord ?? undefined}
        />
      );
    }

    return this.props.children;
  }
}

function CrashPanel({
  actionDisabled = false,
  actionLabel,
  events = [],
  heading,
  intro,
  onAction,
  previousExitInfo,
  previousExitTrace,
  previousJavaCrash,
  record,
}: {
  actionDisabled?: boolean;
  actionLabel: string;
  events?: EventLogEntry[];
  heading: string;
  intro: string;
  onAction: () => void;
  previousExitInfo?: ExitInfo | null;
  previousExitTrace?: ExitTraceSaveResult | null;
  previousJavaCrash?: JavaCrashRecord | null;
  record?: CrashRecord;
}) {
  const hermesEntries = Object.entries(record?.hermesStats ?? {});
  const stackFrames = record?.stackFrames ?? [];
  const javaCrashFrames = previousJavaCrash
    ? getJavaCrashStackFrames(previousJavaCrash)
    : [];

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.heading}>{heading}</Text>
          <Text style={styles.intro}>{intro}</Text>
        </View>

        <View style={styles.card}>
          {previousExitInfo !== undefined ? (
            <Text selectable style={styles.systemExitReason}>
              {formatSystemExitReason(previousExitInfo)}
            </Text>
          ) : null}
          {previousJavaCrash ? (
            <>
              <Text selectable style={styles.systemExitReason}>
                {formatJavaCrashSummary(previousJavaCrash)}
              </Text>
              <View style={styles.section}>
                <Text style={styles.label}>Java 堆栈（前 3 帧）</Text>
                <Text selectable style={styles.mono}>
                  {javaCrashFrames.length > 0
                    ? javaCrashFrames.join("\n")
                    : "无可用堆栈"}
                </Text>
              </View>
            </>
          ) : null}
          {previousExitTrace !== undefined ? (
            <Text selectable style={styles.systemExitReason}>
              {formatSavedExitTrace(previousExitTrace)}
            </Text>
          ) : null}

          {record ? (
            <>
              <DiagnosticLine label="时间" value={record.timestamp} />
              <DiagnosticLine label="错误" value={record.name ?? "未记录"} />
              <DiagnosticLine label="消息" value={record.message} />
              <DiagnosticLine
                label="致命异常"
                value={formatOptionalBoolean(record.isFatal, "是", "否")}
              />
              <DiagnosticLine
                label="应用版本"
                value={record.appVersion ?? "未记录"}
              />
              <DiagnosticLine
                label="当前路由"
                value={record.currentRoute ?? "未记录"}
              />
              <DiagnosticLine
                label="批次进度"
                value={formatBatchProgress(record)}
              />
              <DiagnosticLine
                label="导出 OCR"
                value={formatOptionalBoolean(
                  record.exportOcrResults,
                  "开启",
                  "关闭",
                )}
              />

              <View style={styles.section}>
                <Text style={styles.label}>Hermes 数值</Text>
                <Text selectable style={styles.mono}>
                  {hermesEntries.length > 0
                    ? hermesEntries.map(([key, value]) => `${key}: ${value}`).join("\n")
                    : "无可用数值"}
                </Text>
              </View>

              <View style={styles.section}>
                <Text style={styles.label}>堆栈（前 8 帧）</Text>
                <Text selectable style={styles.mono}>
                  {stackFrames.length > 0
                    ? stackFrames.join("\n")
                    : "无可用堆栈"}
                </Text>
              </View>
            </>
          ) : previousJavaCrash ? null : (
            <DiagnosticLine label="崩溃记录" value="未捕获" />
          )}

          {events.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.label}>上一段事件（最后 20 条）</Text>
              <Text selectable style={styles.mono}>
                {events.map(formatEventLogEntry).join("\n")}
              </Text>
            </View>
          ) : null}
        </View>

        <AppButton
          disabled={actionDisabled}
          label={actionLabel}
          onPress={onAction}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function DiagnosticLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.label}>{label}</Text>
      <Text selectable style={styles.value}>{value}</Text>
    </View>
  );
}

function formatBatchProgress(record: CrashRecord) {
  if (!record.batchProgress) {
    return "无进行中批次";
  }

  const { position, status, totalCount } = record.batchProgress;
  return `第 ${position} 张 / 共 ${totalCount} 张 · ${status}`;
}

function formatOptionalBoolean(
  value: boolean | undefined,
  truthy: string,
  falsy: string,
) {
  if (value === undefined) {
    return "未记录";
  }
  return value ? truthy : falsy;
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: theme.colors.background,
    flex: 1,
  },
  content: {
    gap: 18,
    padding: 20,
  },
  header: {
    gap: 8,
  },
  heading: {
    color: theme.colors.danger,
    fontSize: 28,
    fontWeight: "800",
  },
  intro: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: "#F3C8C8",
    borderRadius: 20,
    borderWidth: 1,
    gap: 14,
    padding: 18,
  },
  line: {
    gap: 4,
  },
  section: {
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    gap: 6,
    paddingTop: 12,
  },
  label: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  value: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    lineHeight: 21,
  },
  mono: {
    color: theme.colors.textPrimary,
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 18,
  },
  systemExitReason: {
    color: theme.colors.textPrimary,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 21,
  },
});
