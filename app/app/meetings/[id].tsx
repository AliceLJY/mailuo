import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { deleteMeeting, getMeetings, updateMeeting } from "@/api";
import { AppButton } from "@/components/button";
import { EmptyHint, SectionCard } from "@/components/page";
import { FieldInput } from "@/components/review/review-fields";
import type { MeetingEditPatch } from "@/connection/dispatch";
import { formatConfirmTime } from "@/time-format";
import { theme } from "@/theme";
import { useToast } from "@/toast-context";
import type { MeetingRecord } from "@/types";

type MeetingParticipantDraft = { contact_id?: number; name: string };

type MeetingFormDraft = {
  title: string;
  time_text: string;
  time_iso: string;
  location: string;
  agenda: string;
  participants: MeetingParticipantDraft[];
};

function toFormDraft(meeting: MeetingRecord): MeetingFormDraft {
  return {
    title: meeting.title,
    time_text: meeting.time_text,
    time_iso: meeting.time_iso ?? "",
    location: meeting.location ?? "",
    agenda: meeting.agenda ?? "",
    participants: meeting.participants.map((participant) => ({ ...participant })),
  };
}

export default function MeetingDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = Number(params.id);
  const { showError, showToast } = useToast();
  const showErrorRef = useRef(showError);
  showErrorRef.current = showError;

  const [meeting, setMeeting] = useState<MeetingRecord | null>(null);
  const [draft, setDraft] = useState<MeetingFormDraft | null>(null);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasLoadedRef = useRef(false);

  const loadMeeting = useCallback(
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
        const meetings = await getMeetings();
        const found = meetings.find((item) => item.id === id) ?? null;
        hasLoadedRef.current = true;
        setMeeting(found);
        setDraft(found ? toFormDraft(found) : null);
        setEditing(false);
        setErrorMessage(found ? null : "这条会议已经不存在了。");
      } catch (error) {
        const fallback = "会议详情加载失败。";
        setErrorMessage(error instanceof Error ? error.message : fallback);
        showErrorRef.current(error, fallback);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [id],
  );

  useFocusEffect(
    useCallback(() => {
      if (!Number.isSafeInteger(id) || id <= 0) {
        return;
      }

      void loadMeeting(hasLoadedRef.current ? "focus" : "initial");
    }, [id, loadMeeting]),
  );

  function startEditing() {
    if (!meeting || saving || deleting) {
      return;
    }

    setDraft(toFormDraft(meeting));
    setEditing(true);
  }

  function cancelEditing() {
    if (meeting) {
      setDraft(toFormDraft(meeting));
    }

    setEditing(false);
  }

  function updateDraft(patch: Partial<MeetingFormDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function updateParticipantName(index: number, name: string) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        participants: current.participants.map((participant, participantIndex) =>
          participantIndex === index ? { ...participant, name } : participant,
        ),
      };
    });
  }

  async function saveMeeting() {
    if (!meeting || !draft || saving) {
      return;
    }

    setSaving(true);

    try {
      const patch: MeetingEditPatch = {
        title: draft.title,
        time_text: draft.time_text,
        time_iso: draft.time_iso.trim() === "" ? null : draft.time_iso,
        location: draft.location.trim() === "" ? null : draft.location,
        agenda: draft.agenda.trim() === "" ? null : draft.agenda,
        participants: draft.participants,
      };
      const result = await updateMeeting(meeting.id, patch);
      setMeeting(result.meeting);
      setDraft(toFormDraft(result.meeting));
      setEditing(false);
      showToast("已保存", "info");
    } catch (error) {
      showError(error, "保存失败，请再试一次。");
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    if (!meeting || deleting) {
      return;
    }

    Alert.alert(
      "删除这条会议？",
      "删除后无法恢复。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除这条会议",
          style: "destructive",
          onPress: () => void performDelete(),
        },
      ],
    );
  }

  async function performDelete() {
    if (!meeting) {
      return;
    }

    setDeleting(true);

    try {
      await deleteMeeting(meeting.id);
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
          <Text style={styles.title}>会议详情</Text>
          <EmptyHint text="页面地址无效。" />
        </View>
      </View>
    );
  }

  const isOther = meeting?.kind === "other";
  const confirmTimeHint = meeting ? formatConfirmTime(meeting.time_iso, meeting.time_text) : null;

  return (
    <View style={styles.page}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            onRefresh={() => void loadMeeting("refresh")}
            refreshing={refreshing}
            tintColor={theme.colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>{meeting?.title ?? "会议详情"}</Text>
          <Text style={styles.subtitle}>
            {meeting
              ? (confirmTimeHint ?? (isOther ? "时间待补充" : "时间待确认"))
              : "标题、时间、地点和相关人都在这里。"}
          </Text>
        </View>

        {loading && !meeting ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={styles.loadingText}>正在读取会议详情…</Text>
          </View>
        ) : null}

        {!loading && !meeting && errorMessage ? (
          <SectionCard title="暂时没加载出来">
            <Text style={styles.note}>{errorMessage}</Text>
            <AppButton label="重新加载" onPress={() => void loadMeeting("refresh")} />
          </SectionCard>
        ) : null}

        {meeting && draft ? (
          <>
            <SectionCard title={isOther ? "事项信息" : "会议信息"}>
              <FieldInput
                editable={editing}
                label="标题"
                value={draft.title}
                onChangeText={(title) => updateDraft({ title })}
              />
              <FieldInput
                editable={editing}
                label="聊天里的时间"
                value={draft.time_text}
                onChangeText={(time_text) => updateDraft({ time_text })}
              />
              {!editing && confirmTimeHint ? (
                <Text style={styles.confirmTimeHint}>{confirmTimeHint}</Text>
              ) : null}
              <FieldInput
                editable={editing}
                label="确认时间"
                multiline
                placeholder="看起来不对就手动改"
                value={draft.time_iso}
                onChangeText={(time_iso) => updateDraft({ time_iso })}
              />
              <FieldInput
                editable={editing}
                label="地点"
                value={draft.location}
                onChangeText={(location) => updateDraft({ location })}
              />
              <FieldInput
                editable={editing}
                label={isOther ? "事项详情" : "议程"}
                multiline
                value={draft.agenda}
                onChangeText={(agenda) => updateDraft({ agenda })}
              />
              {draft.participants.length === 0 && !editing ? (
                <Text style={styles.note}>
                  {isOther ? "暂无相关人。" : "参会人待补充。"}
                </Text>
              ) : (
                draft.participants.map((participant, index) => (
                  <FieldInput
                    key={`${participant.contact_id ?? "name"}-${index}`}
                    editable={editing}
                    label={`${isOther ? "相关人" : "参与人"} ${index + 1}`}
                    value={participant.name}
                    onChangeText={(name) => updateParticipantName(index, name)}
                  />
                ))
              )}
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
                  onPress={() => void saveMeeting()}
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
                label={deleting ? "正在删除…" : "删除这条会议"}
                onPress={confirmDelete}
                tone="danger"
              />
            ) : null}
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
  confirmTimeHint: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: "700",
    marginTop: -4,
  },
  actionRow: {
    flexDirection: "row",
    gap: 12,
  },
  actionButton: {
    flex: 1,
  },
});
