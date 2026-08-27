import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { uploadScreenshot } from "@/api";
import { AppButton } from "@/components/button";
import { EmptyHint, MetaLine, Page, SectionCard } from "@/components/page";
import { useFlow } from "@/flow-context";
import { theme } from "@/theme";
import { useToast } from "@/toast-context";
import type { UploadImageAsset } from "@/types";

export default function UploadScreen() {
  const [asset, setAsset] = useState<UploadImageAsset | null>(null);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingText, setLoadingText] = useState("正在上传截图…");
  const { seedFromUpload } = useFlow();
  const { showError, showToast } = useToast();
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const submitTokenRef = useRef(0);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      clearLoadingTimer(loadingTimerRef.current);
    };
  }, []);

  async function pickImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!mountedRef.current) {
      return;
    }

    if (!permission.granted) {
      showToast("请先允许访问相册，再选择聊天截图。", "info");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
      selectionLimit: 1,
    });
    if (!mountedRef.current) {
      return;
    }

    if (result.canceled || !result.assets[0]) {
      return;
    }

    setAsset({
      uri: result.assets[0].uri,
      fileName: result.assets[0].fileName,
      mimeType: result.assets[0].mimeType,
      width: result.assets[0].width,
      height: result.assets[0].height,
    });
  }

  async function submit() {
    if (!asset) {
      showToast("先选一张聊天截图。", "info");
      return;
    }

    const submitToken = submitTokenRef.current + 1;
    submitTokenRef.current = submitToken;

    try {
      clearLoadingTimer(loadingTimerRef.current);
      setLoading(true);
      setLoadingText("正在上传截图…");
      loadingTimerRef.current = setTimeout(() => {
        if (!canCommitSubmitResult(mountedRef, submitTokenRef, submitToken)) {
          return;
        }
        setLoadingText("AI 正在读图，通常 10-20 秒…");
      }, 2000);
      const response = await uploadScreenshot({ asset, note });
      if (!canCommitSubmitResult(mountedRef, submitTokenRef, submitToken)) {
        return;
      }
      seedFromUpload(response);
      router.push(`/review/${response.screenshot_id}`);
    } catch (error) {
      if (!canCommitSubmitResult(mountedRef, submitTokenRef, submitToken)) {
        return;
      }
      showError(error, "上传失败，请确认服务端地址和局域网连通性。");
    } finally {
      if (!canCommitSubmitResult(mountedRef, submitTokenRef, submitToken)) {
        return;
      }
      clearLoadingTimer(loadingTimerRef.current);
      loadingTimerRef.current = null;
      setLoading(false);
      setLoadingText("正在上传截图…");
    }
  }

  return (
    <View style={styles.screen}>
      <Page
        title="上传截图"
        subtitle="选一张聊天截图，可补一句背景说明。成功后会直接进入卡片确认页。"
        footer={
          <AppButton
            label={loading ? "提交中..." : "提交并生成卡片"}
            disabled={loading || !asset}
            onPress={submit}
          />
        }
      >
        <SectionCard kicker="上传链路" title="本轮会做什么">
          <MetaLine label="选图" value="从相册挑一张聊天截图，支持单张预览。" />
          <MetaLine label="说明" value="补充文字会一起发给后端，帮助 AI 理解上下文。" />
          <MetaLine label="下一步" value="上传成功后初始化 flow，并跳到 /review/[id]。" />
        </SectionCard>

        <SectionCard title="聊天截图">
          {asset ? (
            <View style={styles.previewBox}>
              <Image source={{ uri: asset.uri }} style={styles.previewImage} />
              <Text style={styles.previewName}>{getAssetLabel(asset)}</Text>
              <AppButton label="重新选择" onPress={pickImage} tone="secondary" />
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => void pickImage()}
              style={({ pressed }) => [styles.pickBox, pressed ? styles.pickPressed : null]}
            >
              <Text style={styles.pickTitle}>从相册选截图</Text>
              <Text style={styles.pickText}>支持微信聊天截图，选中后会在这里显示预览和文件名。</Text>
            </Pressable>
          )}
        </SectionCard>

        <SectionCard title="补充说明（可选）">
          <TextInput
            multiline
            onChangeText={setNote}
            placeholder="例如：这是我和陈老师最近三天的聊天，重点看会议时间和他的新公司。"
            placeholderTextColor={theme.colors.textMuted}
            style={styles.input}
            value={note}
          />
          <Text style={styles.helperText}>不写也可以，系统会先按截图内容抽取卡片。</Text>
        </SectionCard>

        {!asset ? <EmptyHint text="先选图，再提交给后端。" /> : null}
      </Page>

      {loading ? (
        <View style={styles.overlay}>
          <View style={styles.overlayCard}>
            <ActivityIndicator color={theme.colors.primary} size="large" />
            <Text style={styles.overlayText}>{loadingText}</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function getAssetLabel(asset: UploadImageAsset) {
  if (asset.fileName?.trim()) {
    return asset.fileName.trim();
  }

  return asset.uri.split("/").filter(Boolean).at(-1) ?? asset.uri;
}

function clearLoadingTimer(timer: ReturnType<typeof setTimeout> | null) {
  if (timer) {
    clearTimeout(timer);
  }
}

function canCommitSubmitResult(
  mountedRef: { current: boolean },
  submitTokenRef: { current: number },
  submitToken: number,
) {
  return mountedRef.current && submitTokenRef.current === submitToken;
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: theme.colors.background,
    flex: 1,
  },
  previewBox: {
    gap: 10,
  },
  previewImage: {
    backgroundColor: theme.colors.surfaceMuted,
    borderRadius: 18,
    height: 220,
    width: "100%",
  },
  previewName: {
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  pickBox: {
    alignItems: "center",
    backgroundColor: theme.colors.primarySoft,
    borderColor: theme.colors.primaryBorder,
    borderRadius: 22,
    borderStyle: "dashed",
    borderWidth: 1,
    gap: 10,
    paddingHorizontal: 18,
    paddingVertical: 28,
  },
  pickPressed: {
    opacity: 0.9,
  },
  pickTitle: {
    color: theme.colors.primary,
    fontSize: 16,
    fontWeight: "800",
  },
  pickText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  input: {
    backgroundColor: theme.colors.surfaceMuted,
    borderColor: theme.colors.border,
    borderRadius: 16,
    borderWidth: 1,
    color: theme.colors.textPrimary,
    fontSize: 15,
    lineHeight: 22,
    minHeight: 120,
    padding: 14,
    textAlignVertical: "top",
  },
  helperText: {
    color: theme.colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  overlay: {
    alignItems: "center",
    backgroundColor: "rgba(20, 33, 26, 0.22)",
    bottom: 0,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  overlayCard: {
    alignItems: "center",
    backgroundColor: theme.colors.surface,
    borderRadius: 24,
    gap: 14,
    minWidth: 240,
    paddingHorizontal: 28,
    paddingVertical: 26,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
  },
  overlayText: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: "700",
  },
});
