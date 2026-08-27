import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { getContactDetail } from "@/api";
import { AppButton } from "@/components/button";
import { ContactInsightHistory } from "@/components/contact-insight-history";
import { ContactObservationTimeline } from "@/components/contact-observation-timeline";
import { EmptyHint, MetaLine, SectionCard } from "@/components/page";
import { useFlow } from "@/flow-context";
import { theme } from "@/theme";
import { useToast } from "@/toast-context";
import type { ContactDetail } from "@/types";

export default function ContactDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = Number(params.id);
  const { contactDetailsById, mergeContactDetail } = useFlow();
  const { showError } = useToast();
  const showErrorRef = useRef(showError);
  const cachedDetail = Number.isSafeInteger(id) ? contactDetailsById[id] ?? null : null;
  const [detail, setDetail] = useState<ContactDetail | null>(cachedDetail);
  const [loading, setLoading] = useState(!cachedDetail);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasLoadedRef = useRef(Boolean(cachedDetail));

  showErrorRef.current = showError;

  useEffect(() => {
    setDetail(cachedDetail);
    setLoading(!cachedDetail);
    setRefreshing(false);
    setErrorMessage(null);
    hasLoadedRef.current = Boolean(cachedDetail);
  }, [cachedDetail, id]);

  const loadDetail = useCallback(
    async (mode: "initial" | "refresh" | "focus") => {
      if (!Number.isSafeInteger(id) || id <= 0) {
        return;
      }

      if (mode === "refresh") {
        setRefreshing(true);
      } else if (!hasLoadedRef.current) {
        setLoading(true);
      }

      try {
        const nextDetail = await getContactDetail(id);
        hasLoadedRef.current = true;
        mergeContactDetail(nextDetail);
        setDetail(nextDetail);
        setErrorMessage(null);
      } catch (error) {
        const fallback = "联系人详情加载失败。";
        setErrorMessage(error instanceof Error ? error.message : fallback);
        showErrorRef.current(error, fallback);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [id, mergeContactDetail],
  );

  useFocusEffect(
    useCallback(() => {
      if (!Number.isSafeInteger(id) || id <= 0) {
        return;
      }

      void loadDetail(hasLoadedRef.current ? "focus" : "initial");
    }, [id, loadDetail]),
  );

  if (!Number.isSafeInteger(id) || id <= 0) {
    return (
      <View style={styles.page}>
        <View style={styles.content}>
          <Text style={styles.title}>联系人详情</Text>
          <EmptyHint text="页面地址无效。" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={() => void loadDetail("refresh")}
            refreshing={refreshing}
            tintColor={theme.colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>{detail?.contact.canonical_name ?? "联系人详情"}</Text>
          <Text style={styles.subtitle}>
            {detail
              ? `${detail.contact.company ?? "公司待补充"} · ${detail.contact.title ?? "职位待补充"}`
              : "基本资料、往来记录和历史洞察会一起显示。"}
          </Text>
        </View>

        {loading && !detail ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={styles.loadingText}>正在读取联系人详情…</Text>
          </View>
        ) : null}

        {!loading && !detail && errorMessage ? (
          <SectionCard title="暂时没加载出来">
            <Text style={styles.note}>{errorMessage}</Text>
            <AppButton label="重新加载" onPress={() => void loadDetail("refresh")} />
          </SectionCard>
        ) : null}

        {!loading && !detail && !errorMessage ? <EmptyHint text="还没有联系人资料。" /> : null}

        {detail ? (
          <>
            <SectionCard title="基本资料">
              <MetaLine label="公司" value={detail.contact.company ?? "未填写"} />
              <MetaLine label="职位" value={detail.contact.title ?? "未填写"} />
              <MetaLine label="电话" value={detail.contact.phone ?? "未填写"} />
              <MetaLine label="微信" value={detail.contact.wechat_id ?? "未填写"} />
              <MetaLine label="别名" value={detail.contact.aliases.join("、") || "无"} />
              <MetaLine label="标签" value={detail.contact.tags.join("、") || "无"} />
              <MetaLine label="备注" value={detail.contact.notes ?? "无"} />
            </SectionCard>

            <ContactObservationTimeline observations={detail.observations} />
            <ContactInsightHistory insights={detail.insights} />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: theme.colors.background,
    flex: 1,
  },
  content: {
    gap: 16,
    paddingBottom: 32,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  header: {
    gap: 8,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 28,
    fontWeight: "800",
  },
  subtitle: {
    color: theme.colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
  },
  loadingBox: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 18,
  },
  loadingText: {
    color: theme.colors.textSecondary,
    fontSize: 14,
  },
  note: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
});
