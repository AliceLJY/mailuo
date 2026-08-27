import { Redirect, router } from "expo-router";
import { useEffect, useState } from "react";
import { Platform, Text } from "react-native";

import { AppButton } from "@/components/button";
import {
  FormNotice,
  LabeledInput,
  SecretField,
} from "@/components/connection-fields";
import { Page, SectionCard } from "@/components/page";
import { useConnection } from "@/connection/context";
import { maskSecret } from "@/connection/presentation";
import { localLlmSecretStore } from "@/connection/secure-store";
import type { LocalLlmSecretName } from "@/connection/secrets";
import { useFlow } from "@/flow-context";
import { theme } from "@/theme";

type KeyName = "DASHSCOPE_API_KEY" | "DEEPSEEK_API_KEY";

type KeyEditorState = {
  editing: boolean;
  mask: string | null;
  value: string;
};

const emptyKeyState: KeyEditorState = { editing: false, mask: null, value: "" };

export default function LocalConnectionScreen() {
  const { saveConfig } = useConnection();
  const { resetFlow } = useFlow();
  const [dashscope, setDashscope] = useState<KeyEditorState>(emptyKeyState);
  const [deepseek, setDeepseek] = useState<KeyEditorState>(emptyKeyState);
  const [qwenModel, setQwenModel] = useState("");
  const [deepseekModel, setDeepseekModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") {
      return;
    }

    let active = true;

    void Promise.all([
      localLlmSecretStore.get("DASHSCOPE_API_KEY"),
      localLlmSecretStore.get("DEEPSEEK_API_KEY"),
      localLlmSecretStore.get("QWEN_MODEL"),
      localLlmSecretStore.get("DEEPSEEK_MODEL"),
    ])
      .then(([dashscopeKey, deepseekKey, storedQwenModel, storedDeepseekModel]) => {
        if (!active) {
          return;
        }

        setDashscope({ ...emptyKeyState, mask: maskSecret(dashscopeKey) });
        setDeepseek({ ...emptyKeyState, mask: maskSecret(deepseekKey) });
        setQwenModel(storedQwenModel ?? "");
        setDeepseekModel(storedDeepseekModel ?? "");
      })
      .catch(() => {
        if (active) {
          setMessage("已保存的内容暂时没有读取出来，请稍后再试。");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  if (Platform.OS === "web") {
    return <Redirect href="/connection/server" />;
  }

  function updateKey(
    setter: (next: KeyEditorState | ((current: KeyEditorState) => KeyEditorState)) => void,
    patch: Partial<KeyEditorState>,
  ) {
    setter((current) => ({ ...current, ...patch }));
    setMessage(null);
  }

  async function clearKey(name: KeyName, setter: typeof setDashscope) {
    try {
      await localLlmSecretStore.clear(name);
      setter({ editing: true, mask: null, value: "" });
      setMessage(null);
    } catch {
      setMessage("这个 Key 暂时没有清除成功，请再试一次。");
    }
  }

  async function saveModel(name: LocalLlmSecretName, value: string) {
    if (value.trim()) {
      await localLlmSecretStore.set(name, value);
    } else {
      await localLlmSecretStore.clear(name);
    }
  }

  async function save() {
    if ((!dashscope.mask && !dashscope.value.trim()) || (!deepseek.mask && !deepseek.value.trim())) {
      setMessage("请把两个模型 Key 都填完整。已设置的 Key 不需要重复填写。");
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      if (dashscope.value.trim()) {
        await localLlmSecretStore.set("DASHSCOPE_API_KEY", dashscope.value);
      }
      if (deepseek.value.trim()) {
        await localLlmSecretStore.set("DEEPSEEK_API_KEY", deepseek.value);
      }
      await saveModel("QWEN_MODEL", qwenModel);
      await saveModel("DEEPSEEK_MODEL", deepseekModel);
      await saveConfig({ mode: "local" });
      resetFlow();
      router.replace("/(tabs)");
    } catch {
      setMessage("配置暂时没有保存成功，请再试一次。");
      setSaving(false);
    }
  }

  return (
    <Page
      title="在这台手机上使用"
      subtitle="档案只保存在这台手机上；整理时，手机会直接连接模型服务商。"
      footer={
        <AppButton
          disabled={loading || saving}
          label={saving ? "正在保存..." : "保存并开始使用"}
          onPress={() => void save()}
        />
      }
    >
      <SectionCard kicker="必填" title="模型 Key">
        <Text style={{ color: theme.colors.textSecondary, fontSize: 13, lineHeight: 19 }}>
          Key 只保存在系统钥匙串中，界面不会显示完整内容。
        </Text>
        <SecretField
          editing={dashscope.editing}
          label="DashScope API Key"
          mask={dashscope.mask}
          onCancelReplace={() => updateKey(setDashscope, { editing: false, value: "" })}
          onChangeText={(value) => updateKey(setDashscope, { value })}
          onClear={() => void clearKey("DASHSCOPE_API_KEY", setDashscope)}
          onReplace={() => updateKey(setDashscope, { editing: true, value: "" })}
          placeholder="粘贴你的 DashScope Key"
          value={dashscope.value}
        />
        <SecretField
          editing={deepseek.editing}
          label="DeepSeek API Key"
          mask={deepseek.mask}
          onCancelReplace={() => updateKey(setDeepseek, { editing: false, value: "" })}
          onChangeText={(value) => updateKey(setDeepseek, { value })}
          onClear={() => void clearKey("DEEPSEEK_API_KEY", setDeepseek)}
          onReplace={() => updateKey(setDeepseek, { editing: true, value: "" })}
          placeholder="粘贴你的 DeepSeek Key"
          value={deepseek.value}
        />
      </SectionCard>

      <SectionCard kicker="选填" title="模型名称">
        <LabeledInput
          autoCapitalize="none"
          autoCorrect={false}
          label="Qwen 模型名"
          onChangeText={setQwenModel}
          placeholder="qwen-vl-max"
          value={qwenModel}
        />
        <LabeledInput
          autoCapitalize="none"
          autoCorrect={false}
          label="DeepSeek 模型名"
          onChangeText={setDeepseekModel}
          placeholder="deepseek-v4-flash"
          value={deepseekModel}
        />
      </SectionCard>

      {message ? <FormNotice message={message} tone="error" /> : null}
    </Page>
  );
}
