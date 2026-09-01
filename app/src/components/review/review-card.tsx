import { StyleSheet, Text, View } from "react-native";

import { AppButton } from "@/components/button";
import { DisclosurePanel } from "@/components/evidence/disclosure-panel";
import {
  ChoiceRow,
  ContactFields,
  InteractionFields,
  MeetingFields,
  UpdateFields,
} from "@/components/review/review-fields";
import { getConfidenceColor, theme } from "@/theme";
import type {
  ActionCardRecord,
  CreateContactPayload,
  CreateMeetingPayload,
  RecordInteractionPayload,
  ReviewCardDraft,
  UpdateContactPayload,
} from "@/types";

type ReviewStage = "current" | "upcoming" | "done";

type Props = {
  card: ActionCardRecord;
  draft: ReviewCardDraft;
  stage: ReviewStage;
  sourceLabels?: string[];
  busy?: boolean;
  errorText?: string | null;
  onDraftChange: (draft: ReviewCardDraft) => void;
  onConfirm: () => void;
  onReject: () => void;
};

const CARD_META = {
  create_contact: { icon: "人", label: "新联系人" },
  update_contact: { icon: "改", label: "更新联系人" },
  create_meeting: { icon: "约", label: "新会议" },
  record_interaction: { icon: "聊", label: "互动记录" },
} satisfies Record<ActionCardRecord["type"], { icon: string; label: string }>;

const STATUS_LABEL = {
  pending: "待确认",
  confirmed: "已确认",
  rejected: "已跳过",
} satisfies Record<ActionCardRecord["status"], string>;

const CONFIDENCE_LABEL = {
  high: "高把握",
  medium: "中等把握",
  low: "待确认",
} satisfies Record<ActionCardRecord["confidence"], string>;

function formatCandidate(candidate: { name: string; company?: string | null }) {
  return candidate.company ? `${candidate.name} · ${candidate.company}` : candidate.name;
}

export function ReviewCard({
  busy = false,
  card,
  draft,
  errorText,
  onConfirm,
  onDraftChange,
  onReject,
  sourceLabels = [],
  stage,
}: Props) {
  const editable = stage === "current" && card.status === "pending";
  const meta =
    card.type === "create_meeting" && card.payload.kind === "other"
      ? { icon: "事", label: "新事项" }
      : CARD_META[card.type];
  const stageText =
    stage === "current" ? "当前这张" : stage === "upcoming" ? "后面还有" : STATUS_LABEL[card.status];
  const confidenceColor = getConfidenceColor(card.confidence);

  function setPayload(payload: ReviewCardDraft["payload"]) {
    onDraftChange({ ...draft, payload });
  }

  function setResolvedContactId(resolved_contact_id: number | null) {
    onDraftChange({ ...draft, resolved_contact_id });
  }

  return (
    <View style={[styles.card, editable ? styles.currentCard : undefined]}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <View style={styles.typeRow}>
            <View style={styles.typeBadge}>
              <Text style={styles.typeIcon}>{meta.icon}</Text>
            </View>
            <Text style={styles.typeLabel}>{meta.label}</Text>
          </View>
          <Text style={styles.stageText}>{stageText}</Text>
        </View>
        <View style={[styles.confidenceBadge, { backgroundColor: `${confidenceColor}18` }]}>
          <View style={[styles.confidenceDot, { backgroundColor: confidenceColor }]} />
          <Text style={styles.confidenceText}>{CONFIDENCE_LABEL[card.confidence]}</Text>
        </View>
      </View>

      {sourceLabels.length ? (
        <Text style={styles.sourceText}>来自 {sourceLabels.join("、")}</Text>
      ) : null}

      {card.type === "create_contact" ? (
        <ContactFields
          editable={editable}
          payload={draft.payload as CreateContactPayload}
          setPayload={setPayload}
        />
      ) : null}
      {card.type === "update_contact" ? (
        <UpdateFields
          editable={editable}
          payload={draft.payload as UpdateContactPayload}
          setPayload={setPayload}
        />
      ) : null}
      {card.type === "create_meeting" ? (
        <MeetingFields
          editable={editable}
          payload={draft.payload as CreateMeetingPayload}
          setPayload={setPayload}
        />
      ) : null}
      {card.type === "record_interaction" ? (
        <InteractionFields
          editable={editable}
          payload={draft.payload as RecordInteractionPayload}
          setPayload={setPayload}
        />
      ) : null}

      {card.disambiguation?.candidates.length ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>这是谁</Text>
          <ChoiceRow
            active={draft.resolved_contact_id == null}
            disabled={!editable}
            label="作为新联系人保存"
            onPress={() => setResolvedContactId(null)}
          />
          {card.disambiguation.candidates.map((candidate) => (
            <ChoiceRow
              key={candidate.contact_id}
              active={draft.resolved_contact_id === candidate.contact_id}
              disabled={!editable}
              label={`合并到 ${formatCandidate(candidate)}`}
              onPress={() => setResolvedContactId(candidate.contact_id)}
            />
          ))}
        </View>
      ) : null}

      <DisclosurePanel title="依据原文" hint="点开查看">
        <Text style={styles.quoteText}>{card.source_quote}</Text>
      </DisclosurePanel>

      {editable ? (
        <View style={styles.actions}>
          <View style={styles.actionRow}>
            <AppButton
              disabled={busy}
              label={busy ? "处理中..." : "确认这张"}
              onPress={onConfirm}
              style={styles.actionButton}
            />
            <AppButton
              disabled={busy}
              label="先跳过"
              onPress={onReject}
              style={styles.actionButton}
              tone="secondary"
            />
          </View>
          {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: theme.colors.surface, borderColor: theme.colors.border, borderRadius: 22, borderWidth: 1, gap: 14, padding: 18 },
  currentCard: { borderColor: theme.colors.primaryBorder, shadowColor: "#000000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.06, shadowRadius: 18 },
  header: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  headerCopy: { flex: 1, gap: 6 },
  typeRow: { alignItems: "center", flexDirection: "row", gap: 10 },
  typeBadge: { alignItems: "center", backgroundColor: theme.colors.primarySoft, borderRadius: 12, height: 28, justifyContent: "center", width: 28 },
  typeIcon: { color: theme.colors.primary, fontSize: 14, fontWeight: "800" },
  typeLabel: { color: theme.colors.textPrimary, fontSize: 18, fontWeight: "800" },
  stageText: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "700" },
  confidenceBadge: { alignItems: "center", borderRadius: 999, flexDirection: "row", gap: 6, paddingHorizontal: 10, paddingVertical: 6 },
  confidenceDot: { borderRadius: 4, height: 8, width: 8 },
  confidenceText: { color: theme.colors.textPrimary, fontSize: 12, fontWeight: "700", textTransform: "uppercase" },
  section: { gap: 12 },
  sectionTitle: { color: theme.colors.textPrimary, fontSize: 14, fontWeight: "700" },
  sourceText: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
  quoteText: { color: theme.colors.textSecondary, fontSize: 14, lineHeight: 21 },
  actions: { gap: 10 },
  actionRow: { flexDirection: "row", gap: 10 },
  actionButton: { flex: 1 },
  errorText: { color: theme.colors.danger, fontSize: 13, lineHeight: 18 },
});
