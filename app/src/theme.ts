export const theme = {
  colors: {
    primary: "#07C160",
    primarySoft: "#E8FAF0",
    primaryBorder: "#B6ECCA",
    background: "#F4F8F5",
    surface: "#FFFFFF",
    surfaceMuted: "#F8FCF9",
    textPrimary: "#14211A",
    textSecondary: "#506358",
    textMuted: "#7B8F83",
    border: "#D9E7DE",
    danger: "#D64545",
    warning: "#C78A11",
    low: "#8B9690"
  }
} as const;

export function getConfidenceColor(level: "high" | "medium" | "low") {
  if (level === "high") {
    return theme.colors.primary;
  }

  if (level === "medium") {
    return theme.colors.warning;
  }

  return theme.colors.low;
}

export function getInsightLabel(kind: "relationship_read" | "suggested_action" | "conversation_hook") {
  if (kind === "relationship_read") {
    return "关系解读";
  }

  if (kind === "suggested_action") {
    return "建议行动";
  }

  return "话头";
}

export function getObservationLabel(kind: "fact" | "preference" | "status_change" | "interaction") {
  if (kind === "fact") {
    return "事实";
  }

  if (kind === "preference") {
    return "偏好";
  }

  if (kind === "status_change") {
    return "状态变化";
  }

  return "互动";
}
