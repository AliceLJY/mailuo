import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { theme } from "@/theme";
import type {
  CreateContactPayload,
  CreateMeetingPayload,
  RecordInteractionPayload,
  ReviewCardDraft,
  UpdateContactPayload,
} from "@/types";

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
            {participant.contact_id ? "已关联到已有联系人" : "先按名字保存"}
          </Text>
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
  return (
    <View style={styles.section}>
      <FieldInput editable={editable} label="对方称呼" value={payload.contact_name} onChangeText={(contact_name) => setPayload({ ...payload, contact_name })} />
      <StaticLine label="当前归属" value={payload.contact_id ? "已关联到已有联系人" : "还没关联到已有联系人"} />
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
