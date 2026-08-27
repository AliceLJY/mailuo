import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text } from "react-native";

import { AppButton } from "@/components/button";
import { FormNotice } from "@/components/connection-fields";
import { Page, SectionCard } from "@/components/page";
import { useConnection } from "@/connection/context";
import { useFlow } from "@/flow-context";
import { theme } from "@/theme";

export default function SettingsScreen() {
  const { clearConfig, config } = useConnection();
  const { resetFlow } = useFlow();
  const [switching, setSwitching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isLocal = config?.mode === "local";

  async function switchMode() {
    setSwitching(true);
    setMessage(null);

    try {
      await clearConfig();
      resetFlow();
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

      <SectionCard title="更换使用方式">
        <Text style={styles.description}>
          更换后会回到选择页。手机里已经保存的模型 Key 不会被显示或删除。
        </Text>
        <AppButton
          disabled={switching}
          label={switching ? "正在切换..." : "切换连接方式"}
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
});
