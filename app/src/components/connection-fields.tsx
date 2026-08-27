import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";

import { theme } from "@/theme";

type LabeledInputProps = TextInputProps & {
  helper?: string;
  label: string;
};

export function LabeledInput({ helper, label, style, ...inputProps }: LabeledInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...inputProps}
        placeholderTextColor={theme.colors.textMuted}
        style={[styles.input, style]}
      />
      {helper ? <Text style={styles.helper}>{helper}</Text> : null}
    </View>
  );
}

type SecretFieldProps = {
  editing: boolean;
  label: string;
  mask: string | null;
  onCancelReplace: () => void;
  onChangeText: (value: string) => void;
  onClear: () => void;
  onReplace: () => void;
  placeholder: string;
  value: string;
};

export function SecretField({
  editing,
  label,
  mask,
  onCancelReplace,
  onChangeText,
  onClear,
  onReplace,
  placeholder,
  value,
}: SecretFieldProps) {
  const shouldShowInput = !mask || editing;

  return (
    <View style={styles.secretField}>
      <Text style={styles.label}>{label}</Text>
      {mask ? (
        <View style={styles.savedRow}>
          <Text style={styles.savedText}>已设置（末 4 位 {mask}）</Text>
          <View style={styles.actions}>
            <InlineAction
              label={editing ? "取消替换" : "替换"}
              onPress={editing ? onCancelReplace : onReplace}
            />
            <InlineAction label="清除" onPress={onClear} tone="danger" />
          </View>
        </View>
      ) : null}
      {shouldShowInput ? (
        <TextInput
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          importantForAutofill="no"
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textMuted}
          secureTextEntry
          selectTextOnFocus
          style={styles.input}
          value={value}
        />
      ) : null}
    </View>
  );
}

function InlineAction({
  label,
  onPress,
  tone = "default",
}: {
  label: string;
  onPress: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      <Text style={[styles.action, tone === "danger" ? styles.dangerAction : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function FormNotice({ message, tone }: { message: string; tone: "error" | "success" }) {
  return (
    <View style={[styles.notice, tone === "error" ? styles.errorNotice : styles.successNotice]}>
      <Text style={tone === "error" ? styles.errorText : styles.successText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: 7,
  },
  secretField: {
    gap: 9,
  },
  label: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  input: {
    backgroundColor: theme.colors.surfaceMuted,
    borderColor: theme.colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: theme.colors.textPrimary,
    fontSize: 15,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  helper: {
    color: theme.colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  savedRow: {
    alignItems: "center",
    backgroundColor: theme.colors.primarySoft,
    borderColor: theme.colors.primaryBorder,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  savedText: {
    color: theme.colors.textSecondary,
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
  },
  actions: {
    flexDirection: "row",
    gap: 14,
  },
  action: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: "700",
  },
  dangerAction: {
    color: theme.colors.danger,
  },
  notice: {
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  errorNotice: {
    backgroundColor: "#FFF4F4",
    borderColor: "#F3C8C8",
  },
  successNotice: {
    backgroundColor: theme.colors.primarySoft,
    borderColor: theme.colors.primaryBorder,
  },
  errorText: {
    color: theme.colors.danger,
    fontSize: 13,
    lineHeight: 19,
  },
  successText: {
    color: theme.colors.primary,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 19,
  },
});
