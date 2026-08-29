import { router } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { AppButton } from "@/components/button";
import { FormNotice, LabeledInput } from "@/components/connection-fields";
import { Page, SectionCard } from "@/components/page";
import { useConnection } from "@/connection/context";
import { testServerConnection } from "@/connection/server-health";
import { useFlow } from "@/flow-context";
import { theme } from "@/theme";

type TestStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "success"; latencyMs: number; serverUrl: string }
  | { kind: "error"; message: string };

export default function ServerConnectionScreen() {
  const { config, saveConfig } = useConnection();
  const { resetFlow } = useFlow();
  const [serverUrl, setServerUrl] = useState("");
  const [status, setStatus] = useState<TestStatus>({ kind: "idle" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config?.mode === "server" && config.serverUrl) {
      setServerUrl(config.serverUrl);
    }
  }, [config]);

  function updateServerUrl(value: string) {
    setServerUrl(value);
    setStatus({ kind: "idle" });
  }

  async function runConnectionTest() {
    setStatus({ kind: "testing" });

    try {
      const result = await testServerConnection(serverUrl);
      setStatus({ kind: "success", ...result });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "测试失败，请稍后再试。",
      });
    }
  }

  async function save() {
    if (status.kind !== "success") {
      setStatus({ kind: "error", message: "请先测试连接，确认服务器可以使用。" });
      return;
    }

    setSaving(true);
    try {
      await saveConfig({ mode: "server", serverUrl: status.serverUrl });
      resetFlow({ preserveExistingBatch: true });
      router.replace("/(tabs)");
    } catch {
      setStatus({ kind: "error", message: "地址暂时没有保存成功，请再试一次。" });
      setSaving(false);
    }
  }

  return (
    <Page
      title="连接自己的服务器"
      subtitle="填入你自建的脉络地址，测试成功后就可以开始使用。"
      footer={
        <AppButton
          disabled={saving || status.kind !== "success"}
          label={saving ? "正在保存..." : "保存并开始使用"}
          onPress={() => void save()}
        />
      }
    >
      <SectionCard title="服务器地址">
        <LabeledInput
          autoCapitalize="none"
          autoCorrect={false}
          helper="填写完整地址，不要在末尾加 /api。"
          keyboardType="url"
          label="地址"
          onChangeText={updateServerUrl}
          placeholder="例如：http://192.168.1.20:3300"
          value={serverUrl}
        />
        <AppButton
          disabled={status.kind === "testing" || !serverUrl.trim()}
          label={status.kind === "testing" ? "正在测试..." : "测试连接"}
          onPress={() => void runConnectionTest()}
          tone="secondary"
        />
      </SectionCard>

      {status.kind === "success" ? (
        <FormNotice
          message={`✓ 连接成功（${status.latencyMs} 毫秒）`}
          tone="success"
        />
      ) : null}
      {status.kind === "error" ? <FormNotice message={status.message} tone="error" /> : null}

      <View style={styles.noteBox}>
        <Text style={styles.noteTitle}>连接后会怎样</Text>
        <Text style={styles.noteText}>截图和档案会交给这台服务器处理与保存。</Text>
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  noteBox: {
    backgroundColor: theme.colors.surfaceMuted,
    borderRadius: 18,
    gap: 6,
    padding: 16,
  },
  noteTitle: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  noteText: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
});
