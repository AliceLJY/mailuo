import { router } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Platform, StyleSheet, Switch, Text, View } from "react-native";

import { clearAllData } from "@/api";
import { AppButton } from "@/components/button";
import { FormNotice } from "@/components/connection-fields";
import { Page, SectionCard } from "@/components/page";
import { getLocalProcessingSettings, type LocalProcessingSettings } from "@/connection/config";
import { useConnection } from "@/connection/context";
import { exportLocalDiagnosticsBundle } from "@/diagnostics/diagnostics-export-runtime";
import { logEvent } from "@/diagnostics/event-log";
import { hasInProgressFlowItems, useFlow } from "@/flow-context";
import { theme } from "@/theme";
import { useToast } from "@/toast-context";

export default function SettingsScreen() {
  const { clearConfig, config, saveConfig } = useConnection();
  const { batchItems, resetFlow } = useFlow();
  const [clearingData, setClearingData] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [savingPreference, setSavingPreference] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isLocal = config?.mode === "local";
  const localProcessing = getLocalProcessingSettings(config);
  const hasInProgressUpload = hasInProgressFlowItems(batchItems);
  const clearingDataRef = useRef(false);
  const exportingDiagnosticsRef = useRef(false);
  const hasInProgressUploadRef = useRef(hasInProgressUpload);
  const { showToast } = useToast();
  hasInProgressUploadRef.current = hasInProgressUpload;

  async function saveLocalProcessing(patch: Partial<LocalProcessingSettings>) {
    if (!config || config.mode !== "local") {
      return;
    }

    setSavingPreference(true);
    setMessage(null);

    try {
      const next = { ...localProcessing, ...patch };
      await saveConfig({
        ...config,
        perceptionPath: next.perceptionPath,
        exportOcrResults: next.exportOcrResults,
      });
    } catch {
      setMessage("处理设置暂时没有保存成功，请再试一次。");
    } finally {
      setSavingPreference(false);
    }
  }

  async function switchMode() {
    if (exportingDiagnosticsRef.current) {
      setMessage("诊断包正在导出，请完成后再切换连接方式。");
      return;
    }

    if (hasInProgressUpload) {
      setMessage("当前内容仍在整理，请完成后再切换连接方式。");
      return;
    }

    setSwitching(true);
    setMessage(null);

    try {
      await clearConfig();
      resetFlow({ preserveExistingBatch: true });
      router.replace("/connection");
    } catch {
      setMessage("暂时没有切换成功，请再试一次。");
      setSwitching(false);
    }
  }

  async function clearLocalData() {
    if (clearingDataRef.current) {
      return;
    }

    if (exportingDiagnosticsRef.current) {
      setMessage("诊断包正在导出，请完成后再清空全部数据。");
      return;
    }

    if (hasInProgressUploadRef.current) {
      setMessage("当前内容仍在整理，请完成后再清空全部数据。");
      return;
    }

    clearingDataRef.current = true;
    setClearingData(true);
    setMessage(null);

    try {
      logEvent("clear_all");
      await clearAllData();
      resetFlow();
      Alert.alert(
        "已清空全部数据",
        "联系人、截图、卡片等本地数据已清空。API Key 与设置已保留。",
      );
    } catch {
      setMessage("暂时没有清空成功，请再试一次。API Key 与设置未受影响。");
    } finally {
      clearingDataRef.current = false;
      setClearingData(false);
    }
  }

  async function exportDiagnostics() {
    if (
      exportingDiagnosticsRef.current ||
      clearingDataRef.current ||
      switching ||
      !isLocal ||
      Platform.OS === "web"
    ) {
      return;
    }

    if (hasInProgressUploadRef.current) {
      setMessage("当前内容仍在整理，请完成后再导出诊断包。");
      return;
    }

    exportingDiagnosticsRef.current = true;
    setExportingDiagnostics(true);
    setMessage(null);

    try {
      const result = await exportLocalDiagnosticsBundle({ connectionMode: "local" });
      showToast(`诊断包已导出到 ${result.directoryName}`, "info");
    } catch (error) {
      const reason = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "诊断包暂时没有导出成功，请确认所选文件夹可写后再试一次。";
      setMessage(reason);
      showToast(reason, "error");
    } finally {
      exportingDiagnosticsRef.current = false;
      setExportingDiagnostics(false);
    }
  }

  function confirmClearAllData() {
    if (clearingDataRef.current) {
      return;
    }

    if (exportingDiagnosticsRef.current) {
      setMessage("诊断包正在导出，请完成后再清空全部数据。");
      return;
    }

    if (hasInProgressUploadRef.current) {
      setMessage("当前内容仍在整理，请完成后再清空全部数据。");
      return;
    }

    setMessage(null);
    Alert.alert(
      "确认清空全部数据？",
      "这会永久清空这台设备上的全部联系人、截图、卡片、会面、观察和洞察等本地数据。API Key 与设置会保留。此操作无法撤销。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "清空全部数据",
          style: "destructive",
          onPress: () => void clearLocalData(),
        },
      ],
    );
  }

  return (
    <Page
      title="设置"
      subtitle="查看现在的使用方式，或更换连接。"
    >
      <SectionCard kicker="当前方式" title={isLocal ? "模型 API Key" : "自己的服务器"}>
        <Text style={styles.description}>
          {isLocal
            ? "档案保存在这台手机上，整理时直接连接模型服务商。"
            : "截图与档案由你设置的脉络服务器处理和保存。"}
        </Text>
        <AppButton
          label={isLocal ? "编辑模型与 Key" : "编辑服务器地址"}
          onPress={() => router.push(isLocal ? "/connection/local" : "/connection/server")}
          tone="secondary"
        />
      </SectionCard>

      {isLocal && Platform.OS === "android" ? (
        <>
          <SectionCard title="截图处理路径">
            <Text style={styles.description}>
              默认先在手机上识字，再把带发言方标记的文字交给模型整理；仅当本地识字或文字整理无法可靠完成时，才回退到云端视觉模型。发言人不确定时仍会继续整理文字。
            </Text>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>始终使用云端视觉识别</Text>
              <Switch
                disabled={savingPreference}
                onValueChange={(value) => void saveLocalProcessing({
                  perceptionPath: value ? "cloud" : "ocr",
                })}
                value={localProcessing.perceptionPath === "cloud"}
              />
            </View>
          </SectionCard>

          <SectionCard title="OCR 验收数据">
            <Text style={styles.description}>
              打开后，每次本地 OCR 完成都会请你选择一个系统文件夹，并把本次原始结果导出为单个 JSON。强制云端时不会生成 OCR 文件。
            </Text>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>导出 OCR 原始结果</Text>
              <Switch
                disabled={savingPreference}
                onValueChange={(value) => void saveLocalProcessing({ exportOcrResults: value })}
                value={localProcessing.exportOcrResults}
              />
            </View>
          </SectionCard>
        </>
      ) : null}

      <SectionCard title="更换使用方式">
        <Text style={styles.description}>
          {hasInProgressUpload
            ? "当前内容仍在整理。处理完成后可以切换连接方式，避免遗漏待确认卡片。"
            : "更换后会回到选择页。手机里已经保存的模型 Key 不会被显示或删除。"}
        </Text>
        <AppButton
          disabled={switching || exportingDiagnostics || hasInProgressUpload}
          label={switching ? "正在切换..." : hasInProgressUpload ? "整理完成后可切换" : "切换连接方式"}
          onPress={() => void switchMode()}
          tone="secondary"
        />
      </SectionCard>

      {Platform.OS !== "web" && config?.mode === "local" ? (
        <>
          <SectionCard title="诊断">
            <Text style={styles.description}>
              把这台设备上的本地档案、原始整理结果、过程记录与黑匣子日志写入你选择的文件夹。内容不脱敏，也不会上传。
            </Text>
            <AppButton
              disabled={
                exportingDiagnostics || clearingData || switching || hasInProgressUpload
              }
              label={
                exportingDiagnostics
                  ? "正在导出..."
                  : hasInProgressUpload
                    ? "整理完成后可导出"
                    : "导出诊断包"
              }
              onPress={() => void exportDiagnostics()}
              tone="secondary"
            />
          </SectionCard>

          <SectionCard title="清空全部数据">
            <Text style={styles.description}>
              清空这台设备上的全部联系人、截图、卡片、会面、观察和洞察等本地数据。API Key 与设置会保留。
            </Text>
            <AppButton
              disabled={clearingData || exportingDiagnostics || hasInProgressUpload}
              label={
                clearingData
                  ? "正在清空..."
                  : hasInProgressUpload
                    ? "整理完成后可清空"
                    : "清空全部数据"
              }
              onPress={confirmClearAllData}
              tone="danger"
            />
          </SectionCard>
        </>
      ) : null}

      {message ? <FormNotice message={message} tone="error" /> : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  description: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 21,
  },
  switchLabel: {
    color: theme.colors.textPrimary,
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
  },
  switchRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 16,
    justifyContent: "space-between",
  },
});
