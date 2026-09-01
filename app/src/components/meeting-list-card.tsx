import { StyleSheet, Text, View } from "react-native";

import { MetaLine } from "@/components/page";
import { theme } from "@/theme";
import type { MeetingRecord } from "@/types";

type Props = {
  meeting: MeetingRecord;
};

export function MeetingListCard({ meeting }: Props) {
  const isOther = meeting.kind === "other";
  const participantNames = meeting.participants.map((item) => item.name).join("、");

  return (
    <View style={styles.card}>
      {isOther ? <Text style={styles.kind}>事项</Text> : null}
      <Text style={styles.title}>{meeting.title}</Text>
      {meeting.time_text.trim() ? (
        <MetaLine label="聊天里的时间" value={meeting.time_text} />
      ) : null}
      <MetaLine
        label={isOther ? "事项时间" : "确认时间"}
        value={formatDateTime(meeting.time_iso) ?? (isOther ? "未指定" : "待确认")}
      />
      <MetaLine label="地点" value={meeting.location ?? "地点待补充"} />
      <MetaLine
        label={isOther ? "相关人" : "参会人"}
        value={participantNames || (isOther ? "暂无相关人" : "参会人待补充")}
      />
      {meeting.agenda ? <Text style={styles.agenda}>{meeting.agenda}</Text> : null}
    </View>
  );
}

function formatDateTime(value: string | null) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "numeric",
  }).format(date);
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderRadius: 22,
    borderWidth: 1,
    gap: 10,
    padding: 18,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 18,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 18,
    fontWeight: "800",
  },
  kind: {
    color: theme.colors.primary,
    fontSize: 12,
    fontWeight: "700",
  },
  agenda: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 2,
  },
});
