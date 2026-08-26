import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";

import { getMeetings } from "@/api";
import { AppButton } from "@/components/button";
import { MeetingListCard } from "@/components/meeting-list-card";
import { EmptyHint, SectionCard } from "@/components/page";
import { theme } from "@/theme";
import { useToast } from "@/toast-context";
import type { MeetingRecord } from "@/types";

export default function MeetingsScreen() {
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { showError } = useToast();
  const showErrorRef = useRef(showError);
  const hasLoadedRef = useRef(false);

  showErrorRef.current = showError;

  const loadMeetings = useCallback(async (mode: "initial" | "refresh" | "focus") => {
    if (mode === "refresh") {
      setRefreshing(true);
    } else if (!hasLoadedRef.current) {
      setLoading(true);
    }

    try {
      const nextMeetings = await getMeetings();
      hasLoadedRef.current = true;
      setMeetings(nextMeetings);
      setErrorMessage(null);
    } catch (error) {
      const fallback = "日程列表加载失败。";
      setErrorMessage(error instanceof Error ? error.message : fallback);
      showErrorRef.current(error, fallback);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadMeetings(hasLoadedRef.current ? "focus" : "initial");
    }, [loadMeetings]),
  );

  return (
    <View style={styles.page}>
      <FlatList
        contentContainerStyle={[
          styles.content,
          meetings.length === 0 ? styles.emptyContent : null,
        ]}
        data={meetings}
        keyExtractor={(item) => String(item.id)}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            {loading ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator color={theme.colors.primary} />
                <Text style={styles.loadingText}>正在读取日程…</Text>
              </View>
            ) : null}

            {!loading && errorMessage ? (
              <SectionCard title="日程暂时没打开">
                <Text style={styles.note}>{errorMessage}</Text>
                <AppButton label="重新加载" onPress={() => void loadMeetings("refresh")} />
              </SectionCard>
            ) : null}

            {!loading && !errorMessage ? <EmptyHint text="还没有会议记录。" /> : null}
          </View>
        }
        ListFooterComponent={<View style={styles.bottomGap} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>日程</Text>
            <Text style={styles.subtitle}>按 API 返回顺序展示标题、时间原文、解析时间、地点和参与人。</Text>
          </View>
        }
        onRefresh={() => void loadMeetings("refresh")}
        refreshing={refreshing}
        renderItem={({ item }) => <MeetingListCard meeting={item} />}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: theme.colors.background,
    flex: 1,
  },
  content: {
    paddingBottom: 32,
    paddingHorizontal: 16,
    paddingTop: 20,
  },
  emptyContent: {
    flexGrow: 1,
  },
  header: {
    gap: 8,
    marginBottom: 16,
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
  separator: {
    height: 14,
  },
  emptyWrap: {
    gap: 16,
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
  bottomGap: {
    height: 8,
  },
});
