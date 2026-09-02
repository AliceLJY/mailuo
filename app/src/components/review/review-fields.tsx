import { createContext, type ReactNode, useContext } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { theme } from "@/theme";
import type {
  ActionCardRecord,
  CreateContactPayload,
  CreateMeetingPayload,
  LocalBatchAnchorInfo,
  RecordInteractionPayload,
  ReviewCardDraft,
  UpdateContactPayload,
} from "@/types";

export type ReviewLocalBatchAnchorInfo = LocalBatchAnchorInfo & {
  same_screenshot: boolean;
};

const LocalBatchAnchorContext = createContext<ReviewLocalBatchAnchorInfo | null>(null);

export function LocalBatchAnchorProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: ReviewLocalBatchAnchorInfo | null;
}) {
  return (
    <LocalBatchAnchorContext.Provider value={value}>
      {children}
    </LocalBatchAnchorContext.Provider>
  );
}

function normalizeContactName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function resolveReviewLocalBatchAnchor(
  card: ActionCardRecord,
  orderedCards: ActionCardRecord[],
  payload: RecordInteractionPayload | null,
): ReviewLocalBatchAnchorInfo | null {
  const hydratedAnchor = card.disambiguation?.local_batch_anchor;

  if (hydratedAnchor) {
    const liveAnchor = orderedCards.find(
      (candidate) => candidate.id === hydratedAnchor.anchor_card_id,
    );

    if (!liveAnchor) {
      return { ...hydratedAnchor, same_screenshot: false };
    }

    if (liveAnchor.type !== "create_contact") {
      return {
        anchor_card_id: hydratedAnchor.anchor_card_id,
        name: null,
        same_screenshot: liveAnchor.screenshot_id === card.screenshot_id,
        status: "missing",
      };
    }

    return {
      anchor_card_id: liveAnchor.id,
      name: liveAnchor.payload.name.trim() || null,
      same_screenshot: liveAnchor.screenshot_id === card.screenshot_id,
      status: liveAnchor.status,
    };
  }

  if (
    card.type !== "record_interaction" ||
    !payload ||
    payload.contact_id != null ||
    card.disambiguation?.local_batch_deferred
  ) {
    return null;
  }

  const displayedName = normalizeContactName(payload.contact_name);
  if (!displayedName) {
    return null;
  }

  const matchingAnchors = orderedCards.flatMap((candidate) => {
    if (
      candidate.screenshot_id !== card.screenshot_id ||
      candidate.type !== "create_contact"
    ) {
      return [];
    }

    const matches = [candidate.payload.name, ...(candidate.payload.aliases ?? [])]
      .map(normalizeContactName)
      .includes(displayedName);

    return matches
      ? [{
          anchor_card_id: candidate.id,
          name: candidate.payload.name.trim() || null,
          resolved_contact_id: candidate.resolved_contact_id,
          same_screenshot: true as const,
          status: candidate.status,
        }]
      : [];
  });

  const confirmedByContactId = new Map<number, (typeof matchingAnchors)[number]>();
  for (const anchor of matchingAnchors) {
    if (anchor.status === "confirmed" && anchor.resolved_contact_id != null) {
      confirmedByContactId.set(anchor.resolved_contact_id, anchor);
    }
  }

  if (confirmedByContactId.size > 1) {
    return null;
  }

  const confirmedAnchor = confirmedByContactId.values().next().value;
  const anchor = confirmedAnchor
    ?? matchingAnchors.find((candidate) => candidate.status === "pending")
    ?? matchingAnchors.find((candidate) => candidate.status === "rejected");

  if (!anchor) {
    return null;
  }

  return {
    anchor_card_id: anchor.anchor_card_id,
    name: anchor.name,
    same_screenshot: true,
    status: anchor.status,
  };
}

export function getInteractionDependencyMessage(
  anchor: ReviewLocalBatchAnchorInfo | null,
) {
  if (!anchor?.same_screenshot || !anchor.name) {
    return null;
  }

  if (anchor.status === "pending") {
    return `请先确认『新建联系人 ${anchor.name}』那张卡`;
  }

  if (anchor.status === "rejected") {
    return `这张互动依赖的『新建联系人 ${anchor.name}』已被跳过，请把这张也跳过，或先手动新建该联系人`;
  }

  return null;
}

export function formatInteractionOwnership(
  payload: RecordInteractionPayload,
  anchor: ReviewLocalBatchAnchorInfo | null,
) {
  if (anchor?.name) {
    if (anchor.same_screenshot && anchor.status === "pending") {
      return `将关联到本张新建的联系人：${anchor.name}（待确认）`;
    }

    if (anchor.same_screenshot && anchor.status === "rejected") {
      return `将关联到本张新建的联系人：${anchor.name}（已被跳过）`;
    }

    if (anchor.same_screenshot && anchor.status === "confirmed") {
      return `将关联到本张新建的联系人：${anchor.name}（已确认）`;
    }

    if (anchor.status === "pending") {
      return `将关联到本批新建的联系人：${anchor.name}（待确认）`;
    }

    if (anchor.status === "rejected") {
      return `依赖的『新建联系人 ${anchor.name}』已被跳过`;
    }
  }

  return payload.contact_id
    ? "已关联到已有联系人"
    : "还没关联到已有联系人";
}

const FIELD_LABELS = {
  company: "公司",
  title: "职位",
  phone: "电话",
  wechat_id: "微信号",
  notes: "备注",
} as const;

type ContactFieldKey = keyof typeof FIELD_LABELS;

function splitList(value: string) {
  return value
    .split(/[,\n，]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatParticipantCandidate(
  candidate: NonNullable<
    CreateMeetingPayload["participants"][number]["candidates"]
  >[number],
) {
  const contact = candidate.company
    ? `${candidate.name} · ${candidate.company}`
    : candidate.name;
  return candidate.contact_id < 0 ? `${contact}（本批新建）` : contact;
}

const CHANGE_LABELS = {
  aliases: "追加别名",
  company: "公司",
  title: "职位",
  phone: "电话",
  wechat_id: "微信号",
  notes: "备注",
} as const;

const MEETING_CHANGE_LABELS = {
  title: "标题",
  time_iso: "确认时间",
  time_text: "聊天里的时间",
  location: "地点",
  participants: "相关人",
  agenda: "详情",
} as const;

export function ContactFields({
  editable,
  payload,
  setPayload,
}: {
  editable: boolean;
  payload: CreateContactPayload;
  setPayload: (payload: ReviewCardDraft["payload"]) => void;
}) {
  return (
    <View style={styles.section}>
      <FieldInput editable={editable} label="姓名" value={payload.name} onChangeText={(name) => setPayload({ ...payload, name })} />
      <FieldInput
        editable={editable}
        label="别名"
        value={(payload.aliases ?? []).join("，")}
        onChangeText={(aliases) => setPayload({ ...payload, aliases: splitList(aliases) })}
        placeholder="多个别名用逗号分隔"
      />
      {(["company", "title", "phone", "wechat_id", "notes"] as ContactFieldKey[]).map((field) => (
        <FieldInput
          key={field}
          editable={editable}
          label={FIELD_LABELS[field]}
          multiline={field === "notes"}
          value={payload[field] ?? ""}
          onChangeText={(value) => setPayload({ ...payload, [field]: value })}
        />
      ))}
    </View>
  );
}

export function UpdateFields({
  editable,
  payload,
  setPayload,
}: {
  editable: boolean;
  payload: UpdateContactPayload;
  setPayload: (payload: ReviewCardDraft["payload"]) => void;
}) {
  return (
    <View style={styles.section}>
      <StaticLine label="联系人" value={payload.contact_name} />
      {Object.entries(payload.changes).map(([field, change]) => (
        <View key={field} style={styles.block}>
          <Text style={styles.fieldLabel}>{CHANGE_LABELS[field as keyof typeof CHANGE_LABELS] ?? field}</Text>
          <Text style={styles.metaText}>
            {field === "aliases" ? "已有别名" : "当前记录"}：{change.old || "未填写"}
          </Text>
          <FieldInput
            editable={editable}
            label={field === "aliases" ? "确认追加的别名" : "确认后的内容"}
            value={change.new}
            onChangeText={(value) =>
              setPayload({
                ...payload,
                changes: {
                  ...payload.changes,
                  [field]: {
                    ...change,
                    new: value,
                  },
                },
              })
            }
          />
        </View>
      ))}
    </View>
  );
}

export function MeetingFields({
  editable,
  payload,
  setPayload,
}: {
  editable: boolean;
  payload: CreateMeetingPayload;
  setPayload: (payload: ReviewCardDraft["payload"]) => void;
}) {
  const isOther = payload.kind === "other";
  const isProgressUpdate = payload.agenda_append != null;
  const duplicateChanges = Object.entries(payload.changes ?? {});

  if (isProgressUpdate) {
    const existingAgenda = payload.changes?.agenda?.old ?? null;

    return (
      <View style={styles.section}>
        <View style={styles.block}>
          <Text style={styles.fieldLabel}>更新事项备注</Text>
          <Text style={styles.metaText}>
            确认后只把这段推进追加到现有事项 #{payload.duplicate_of_meeting_id}，不会覆盖其他更新。
          </Text>
        </View>
        <StaticLine label="事项" value={payload.title} />
        {existingAgenda ? <StaticLine label="现有备注" value={existingAgenda} /> : null}
        <FieldInput
          editable={editable}
          label="追加事项备注"
          multiline
          value={payload.agenda_append ?? ""}
          onChangeText={(agenda_append) => {
            const normalizedAppend = agenda_append.trim();
            const agenda = [existingAgenda, normalizedAppend].filter(Boolean).join("；");
            setPayload({
              ...payload,
              agenda_append,
              agenda,
              changes: {
                ...payload.changes,
                agenda: { old: existingAgenda, new: agenda || null },
              },
            });
          }}
        />
        {payload.participants.length ? (
          <StaticLine
            label={isOther ? "相关人" : "参与人"}
            value={payload.participants.map((participant) => participant.name).join("、")}
          />
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.section}>
      {payload.duplicate_of_meeting_id != null ? (
        <View style={styles.block}>
          <Text style={styles.fieldLabel}>已有相似事项 → 是否更新</Text>
          <Text style={styles.metaText}>
            确认后将更新现有记录 #{payload.duplicate_of_meeting_id}，不会新增一条。
          </Text>
          <Text style={styles.metaText}>
            差异仅作提示；实际更新以下方表单为准，确认记录会按最终内容重新核算。
          </Text>
          {duplicateChanges.length === 0 ? (
            <Text style={styles.metaText}>当前差异为空。</Text>
          ) : duplicateChanges.map(([field, change]) => (
            <View key={field} style={styles.block}>
              <Text style={styles.fieldLabel}>
                {MEETING_CHANGE_LABELS[field as keyof typeof MEETING_CHANGE_LABELS] ?? field}
              </Text>
              <Text style={styles.metaText}>对照值：{change?.old || "未填写"}</Text>
              <Text style={styles.metaText}>变更值：{change?.new || "未填写"}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <FieldInput editable={editable} label="标题" value={payload.title} onChangeText={(title) => setPayload({ ...payload, title })} />
      <View style={styles.dualRow}>
        <View style={styles.dualColumn}>
          <FieldInput editable={editable} label="聊天里的时间" value={payload.time_text} onChangeText={(time_text) => setPayload({ ...payload, time_text })} />
        </View>
        <View style={styles.dualColumn}>
          <FieldInput
            editable={editable}
            emphasis
            label="确认时间"
            value={payload.time_iso ?? ""}
            onChangeText={(time_iso) => setPayload({ ...payload, time_iso: time_iso || null })}
            placeholder="看起来不对就手动改"
          />
        </View>
      </View>
      <FieldInput editable={editable} label="地点" value={payload.location ?? ""} onChangeText={(location) => setPayload({ ...payload, location })} />
      <FieldInput
        editable={editable}
        label={isOther ? "事项详情" : "议程"}
        multiline
        value={payload.agenda ?? ""}
        onChangeText={(agenda) => setPayload({ ...payload, agenda })}
      />
      {payload.participants.map((participant, index) => (
        <View key={`${participant.contact_id ?? "name"}-${index}`} style={styles.block}>
          <Text style={styles.fieldLabel}>{isOther ? "相关人" : "参与人"} {index + 1}</Text>
          <Text style={styles.metaText}>
            {participant.contact_id == null
              ? "先按名字保存"
              : participant.contact_id < 0
                ? "已选择本批新建联系人"
                : "已关联到已有联系人"}
          </Text>
          {participant.contact_id == null
            ? participant.candidates?.map((candidate) => (
                <View key={candidate.contact_id} style={styles.candidateRow}>
                  <Text style={[styles.metaText, styles.candidateText]}>
                    可能是：{formatParticipantCandidate(candidate)}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    disabled={!editable}
                    onPress={() =>
                      setPayload({
                        ...payload,
                        participants: payload.participants.map((item, itemIndex) => {
                          if (itemIndex !== index) {
                            return item;
                          }
                          const { candidates: _candidates, ...selected } = item;
                          return { ...selected, contact_id: candidate.contact_id };
                        }),
                      })
                    }
                    style={[styles.candidateButton, !editable ? styles.disabled : undefined]}
                  >
                    <Text style={styles.candidateButtonText}>就是这位</Text>
                  </Pressable>
                </View>
              ))
            : null}
          <FieldInput
            editable={editable}
            label="姓名"
            value={participant.name}
            onChangeText={(name) =>
              setPayload({
                ...payload,
                participants: payload.participants.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, name } : item,
                ),
              })
            }
          />
        </View>
      ))}
    </View>
  );
}

export function InteractionFields({
  editable,
  payload,
  setPayload,
}: {
  editable: boolean;
  payload: RecordInteractionPayload;
  setPayload: (payload: ReviewCardDraft["payload"]) => void;
}) {
  const localBatchAnchor = useContext(LocalBatchAnchorContext);
  const ownership = formatInteractionOwnership(payload, localBatchAnchor);

  return (
    <View style={styles.section}>
      <FieldInput editable={editable} label="对方称呼" value={payload.contact_name} onChangeText={(contact_name) => setPayload({ ...payload, contact_name })} />
      <StaticLine label="当前归属" value={ownership} />
      <FieldInput editable={editable} label="这次互动摘要" multiline value={payload.summary} onChangeText={(summary) => setPayload({ ...payload, summary })} />
    </View>
  );
}

export function ChoiceRow({
  active,
  disabled,
  label,
  onPress,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.choiceRow, active ? styles.choiceRowActive : undefined]}
    >
      <View style={[styles.choiceCircle, active ? styles.choiceCircleActive : undefined]} />
      <Text style={styles.choiceLabel}>{label}</Text>
    </Pressable>
  );
}

function FieldInput({
  editable,
  emphasis = false,
  label,
  multiline = false,
  onChangeText,
  placeholder,
  value,
}: {
  editable: boolean;
  emphasis?: boolean;
  label: string;
  multiline?: boolean;
  onChangeText: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {editable ? (
        <TextInput
          accessibilityLabel={label}
          multiline={multiline}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textMuted}
          style={[styles.input, multiline ? styles.multiline : undefined, emphasis ? styles.emphasisInput : undefined]}
          value={value}
        />
      ) : (
        <Text style={[styles.staticValue, emphasis ? styles.emphasisText : undefined]}>{value || "未填写"}</Text>
      )}
    </View>
  );
}

function StaticLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.staticValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  block: { backgroundColor: theme.colors.surfaceMuted, borderRadius: 16, gap: 8, padding: 12 },
  candidateRow: { alignItems: "center", flexDirection: "row", gap: 10, justifyContent: "space-between" },
  candidateButton: { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primaryBorder, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  candidateButtonText: { color: theme.colors.primary, fontSize: 13, fontWeight: "700" },
  candidateText: { flex: 1 },
  disabled: { opacity: 0.45 },
  dualRow: { flexDirection: "row", gap: 10 },
  dualColumn: { flex: 1 },
  field: { gap: 6 },
  fieldLabel: { color: theme.colors.textMuted, fontSize: 12, fontWeight: "700" },
  input: { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.border, borderRadius: 14, borderWidth: 1, color: theme.colors.textPrimary, fontSize: 15, minHeight: 46, paddingHorizontal: 12, paddingVertical: 11 },
  emphasisInput: { backgroundColor: "#F3FFF8", borderColor: theme.colors.primary },
  multiline: { minHeight: 90, textAlignVertical: "top" },
  staticValue: { color: theme.colors.textSecondary, fontSize: 15, lineHeight: 21 },
  emphasisText: { color: theme.colors.primary, fontWeight: "700" },
  metaText: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
  choiceRow: { alignItems: "center", borderColor: theme.colors.border, borderRadius: 14, borderWidth: 1, flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  choiceRowActive: { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary },
  choiceCircle: { borderColor: theme.colors.textMuted, borderRadius: 999, borderWidth: 1.5, height: 14, width: 14 },
  choiceCircleActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  choiceLabel: { color: theme.colors.textPrimary, flex: 1, fontSize: 14, lineHeight: 19 },
});
