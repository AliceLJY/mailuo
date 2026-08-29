import { router } from "expo-router";
import { useState } from "react";
import { Platform, StyleSheet, Switch, Text, View } from "react-native";

import { AppButton } from "@/components/button";
import { FormNotice } from "@/components/connection-fields";
import { Page, SectionCard } from "@/components/page";
import { getLocalProcessingSettings, type LocalProcessingSettings } from "@/connection/config";
import { useConnection } from "@/connection/context";
import { hasInProgressFlowItems, useFlow } from "@/flow-context";
import { theme } from "@/theme";

export default function SettingsScreen() {
  const { clearConfig, config, saveConfig } = useConnection();
  const { batchItems, resetFlow } = useFlow();
  const [switching, setSwitching] = useState(false);
  const [savingPreference, setSavingPreference] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isLocal = config?.mode === "local";
  const localProcessing = getLocalProcessingSettings(config);
  const hasInProgressUpload = hasInProgressFlowItems(batchItems);

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
              默认先在手机上识字，再把带发言方标记的文字交给模型整理；只有没认出文字或多数文字置信度明显偏低时才改用云端视觉，发言人不确定仍会继续整理文字。
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
          disabled={switching || hasInProgressUpload}
          label={switching ? "正在切换..." : hasInProgressUpload ? "整理完成后可切换" : "切换连接方式"}
          onPress={() => void switchMode()}
          tone="secondary"
        />
      </SectionCard>

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
