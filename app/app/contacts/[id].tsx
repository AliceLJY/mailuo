import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { deleteContact, getContactDetail, updateContact } from "@/api";
import { AppButton } from "@/components/button";
import { ContactInsightHistory } from "@/components/contact-insight-history";
import { ContactObservationTimeline } from "@/components/contact-observation-timeline";
import { EmptyHint, SectionCard } from "@/components/page";
import { FieldInput } from "@/components/review/review-fields";
import { parseSelfNamesInput } from "@/connection/config";
import type { ContactEditPatch } from "@/connection/dispatch";
import { useFlow } from "@/flow-context";
import { theme } from "@/theme";
import { useToast } from "@/toast-context";
import type { ContactDetail, ContactRecord } from "@/types";

type ContactFormDraft = {
  canonical_name: string;
  company: string;
  title: string;
  phone: string;
  wechat_id: string;
  aliasesText: string;
  tagsText: string;
  notes: string;
};

function toContactFormDraft(contact: ContactRecord): ContactFormDraft {
  return {
    canonical_name: contact.canonical_name,
    company: contact.company ?? "",
    title: contact.title ?? "",
    phone: contact.phone ?? "",
    wechat_id: contact.wechat_id ?? "",
    aliasesText: contact.aliases.join("，"),
    tagsText: contact.tags.join("，"),
    notes: contact.notes ?? "",
  };
}

export default function ContactDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = Number(params.id);
  const { contactDetailsById, mergeContactDetail } = useFlow();
  const { showError, showToast } = useToast();
  const showErrorRef = useRef(showError);
  const cachedDetail = Number.isSafeInteger(id) ? contactDetailsById[id] ?? null : null;
  const [detail, setDetail] = useState<ContactDetail | null>(cachedDetail);
  const [draft, setDraft] = useState<ContactFormDraft | null>(
    cachedDetail ? toContactFormDraft(cachedDetail.contact) : null,
  );
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(!cachedDetail);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasLoadedRef = useRef(Boolean(cachedDetail));

  showErrorRef.current = showError;

  useEffect(() => {
    setDetail(cachedDetail);
    setDraft(cachedDetail ? toContactFormDraft(cachedDetail.contact) : null);
    setEditing(false);
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
        setDraft(toContactFormDraft(nextDetail.contact));
        setEditing(false);
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

  function startEditing() {
    if (!detail || saving || deleting) {
      return;
    }

    setDraft(toContactFormDraft(detail.contact));
    setEditing(true);
  }

  function cancelEditing() {
    if (detail) {
      setDraft(toContactFormDraft(detail.contact));
    }

    setEditing(false);
  }

  function updateDraft(patch: Partial<ContactFormDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  async function saveContact() {
    if (!detail || !draft || saving) {
      return;
    }

    setSaving(true);

    try {
      const patch: ContactEditPatch = {
        canonical_name: draft.canonical_name,
        company: draft.company,
        title: draft.title,
        phone: draft.phone,
        wechat_id: draft.wechat_id,
        notes: draft.notes,
        aliases: parseSelfNamesInput(draft.aliasesText),
        tags: parseSelfNamesInput(draft.tagsText),
      };
      const result = await updateContact(detail.contact.id, patch);
      mergeContactDetail(result.contact);
      setDetail(result.contact);
      setDraft(toContactFormDraft(result.contact.contact));
      setEditing(false);
      showToast("已保存", "info");
    } catch (error) {
      showError(error, "保存失败，请再试一次。");
    } finally {
      setSaving(false);
    }
  }

  function confirmDeleteContact() {
    if (!detail || deleting) {
      return;
    }

    Alert.alert(
      "删除这个联系人？",
      `会一并删除${detail.contact.canonical_name}的观察记录与洞察；出现过的会议会保留名字，只是不再关联这位联系人。此操作无法撤销。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除联系人",
          style: "destructive",
          onPress: () => void performDeleteContact(),
        },
      ],
    );
  }

  async function performDeleteContact() {
    if (!detail) {
      return;
    }

    setDeleting(true);

    try {
      await deleteContact(detail.contact.id);
      showToast("已删除", "info");
      router.back();
    } catch (error) {
      showError(error, "删除失败，请再试一次。");
      setDeleting(false);
    }
  }

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

        {detail && draft ? (
          <>
            <SectionCard title="基本资料">
              <FieldInput
                editable={editing}
                label="姓名"
                value={draft.canonical_name}
                onChangeText={(canonical_name) => updateDraft({ canonical_name })}
              />
              <FieldInput
                editable={editing}
                label="公司"
                value={draft.company}
                onChangeText={(company) => updateDraft({ company })}
              />
              <FieldInput
                editable={editing}
                label="职位"
                value={draft.title}
                onChangeText={(title) => updateDraft({ title })}
              />
              <FieldInput
                editable={editing}
                label="电话"
                value={draft.phone}
                onChangeText={(phone) => updateDraft({ phone })}
              />
              <FieldInput
                editable={editing}
                label="微信"
                value={draft.wechat_id}
                onChangeText={(wechat_id) => updateDraft({ wechat_id })}
              />
              <FieldInput
                editable={editing}
                label="别名"
                placeholder="多个别名用逗号分隔"
                value={draft.aliasesText}
                onChangeText={(aliasesText) => updateDraft({ aliasesText })}
              />
              <FieldInput
                editable={editing}
                label="标签"
                placeholder="多个标签用逗号分隔"
                value={draft.tagsText}
                onChangeText={(tagsText) => updateDraft({ tagsText })}
              />
              <FieldInput
                editable={editing}
                label="备注"
                multiline
                value={draft.notes}
                onChangeText={(notes) => updateDraft({ notes })}
              />
            </SectionCard>

            {editing ? (
              <View style={styles.actionRow}>
                <AppButton
                  disabled={saving}
                  label="取消"
                  onPress={cancelEditing}
                  style={styles.actionButton}
                  tone="secondary"
                />
                <AppButton
                  disabled={saving}
                  label={saving ? "正在保存…" : "保存"}
                  onPress={() => void saveContact()}
                  style={styles.actionButton}
                />
              </View>
            ) : (
              <View style={styles.actionRow}>
                <AppButton label="编辑" onPress={startEditing} style={styles.actionButton} />
              </View>
            )}

            {!editing ? (
              <AppButton
                disabled={deleting}
                label={deleting ? "正在删除…" : "删除联系人"}
                onPress={confirmDeleteContact}
                tone="danger"
              />
            ) : null}

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
  actionRow: {
    flexDirection: "row",
    gap: 12,
  },
  actionButton: {
    flex: 1,
  },
});
