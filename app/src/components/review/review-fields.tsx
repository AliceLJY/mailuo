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
          <Text style={styles.fieldLabel}>{FIELD_LABELS[field as ContactFieldKey] ?? field}</Text>
          <Text style={styles.metaText}>原值：{change.old || "空"}</Text>
          <FieldInput
            editable={editable}
            label="新值"
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
  return (
    <View style={styles.section}>
      <FieldInput editable={editable} label="标题" value={payload.title} onChangeText={(title) => setPayload({ ...payload, title })} />
      <View style={styles.dualRow}>
        <View style={styles.dualColumn}>
          <FieldInput editable={editable} label="原文时间" value={payload.time_text} onChangeText={(time_text) => setPayload({ ...payload, time_text })} />
        </View>
        <View style={styles.dualColumn}>
          <FieldInput
            editable={editable}
            emphasis
            label="ISO 时间"
            value={payload.time_iso ?? ""}
            onChangeText={(time_iso) => setPayload({ ...payload, time_iso: time_iso || null })}
            placeholder="可手动修正"
          />
        </View>
      </View>
      <FieldInput editable={editable} label="地点" value={payload.location ?? ""} onChangeText={(location) => setPayload({ ...payload, location })} />
      <FieldInput
        editable={editable}
        label="议程"
        multiline
        value={payload.agenda ?? ""}
        onChangeText={(agenda) => setPayload({ ...payload, agenda })}
      />
      {payload.participants.map((participant, index) => (
        <View key={`${participant.contact_id ?? "name"}-${index}`} style={styles.block}>
          <Text style={styles.fieldLabel}>参与人 {index + 1}</Text>
          <Text style={styles.metaText}>
            {participant.contact_id ? `保留 contact_id #${participant.contact_id}` : "未关联 contact_id"}
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
      <FieldInput editable={editable} label="联系人称呼" value={payload.contact_name} onChangeText={(contact_name) => setPayload({ ...payload, contact_name })} />
      <StaticLine label="关联 contact_id" value={payload.contact_id ? String(payload.contact_id) : "未关联"} />
      <FieldInput editable={editable} label="互动摘要" multiline value={payload.summary} onChangeText={(summary) => setPayload({ ...payload, summary })} />
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
        <Text style={[styles.staticValue, emphasis ? styles.emphasisText : undefined]}>{value || "空"}</Text>
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
