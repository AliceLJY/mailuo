import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";

import { getContacts } from "@/api";
import { AppButton } from "@/components/button";
import { ContactListCard } from "@/components/contact-list-card";
import { EmptyHint, SectionCard } from "@/components/page";
import { theme } from "@/theme";
import { useToast } from "@/toast-context";
import type { ContactListItem } from "@/types";

export default function ContactsScreen() {
  const [contacts, setContacts] = useState<ContactListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { showError } = useToast();
  const showErrorRef = useRef(showError);
  const hasLoadedRef = useRef(false);

  showErrorRef.current = showError;

  const loadContacts = useCallback(async (mode: "initial" | "refresh" | "focus") => {
    if (mode === "refresh") {
      setRefreshing(true);
    } else if (!hasLoadedRef.current) {
      setLoading(true);
    }

    try {
      const nextContacts = await getContacts();
      hasLoadedRef.current = true;
      setContacts(nextContacts);
      setErrorMessage(null);
    } catch (error) {
      const fallback = "人脉加载失败。";
      setErrorMessage(error instanceof Error ? error.message : fallback);
      showErrorRef.current(error, fallback);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadContacts(hasLoadedRef.current ? "focus" : "initial");
    }, [loadContacts]),
  );

  return (
    <View style={styles.page}>
      <FlatList
        contentContainerStyle={[
          styles.content,
          contacts.length === 0 ? styles.emptyContent : null,
        ]}
        data={contacts}
        keyExtractor={(item) => String(item.id)}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            {loading ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator color={theme.colors.primary} />
                <Text style={styles.loadingText}>正在读取联系人…</Text>
              </View>
            ) : null}

            {!loading && errorMessage ? (
              <SectionCard title="暂时没加载出来">
                <Text style={styles.note}>{errorMessage}</Text>
                <AppButton label="重新加载" onPress={() => void loadContacts("refresh")} />
              </SectionCard>
            ) : null}

            {!loading && !errorMessage ? (
              <EmptyHint text="还没有联系人，先去上传截图或粘贴聊天文本。" />
            ) : null}
          </View>
        }
        ListFooterComponent={<View style={styles.bottomGap} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title}>人脉</Text>
            <Text style={styles.subtitle}>名字、公司和最近来往都在这里，下拉会刷新。</Text>
          </View>
        }
        onRefresh={() => void loadContacts("refresh")}
        refreshing={refreshing}
        renderItem={({ item }) => (
          <ContactListCard
            contact={item}
            onPress={() => router.push(`/contacts/${item.id}`)}
          />
        )}
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
