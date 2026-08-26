import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { theme } from "@/theme";

type ButtonTone = "primary" | "secondary" | "danger";

type Props = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: ButtonTone;
  style?: StyleProp<ViewStyle>;
};

export function AppButton({
  label,
  onPress,
  disabled = false,
  tone = "primary",
  style,
}: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        tone === "primary" ? styles.primary : undefined,
        tone === "secondary" ? styles.secondary : undefined,
        tone === "danger" ? styles.danger : undefined,
        pressed && !disabled ? styles.pressed : undefined,
        disabled ? styles.disabled : undefined,
        style,
      ]}
    >
      <View>
        <Text
          style={[
            styles.label,
            tone === "primary" ? styles.primaryLabel : styles.secondaryLabel,
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 16,
  },
  primary: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  secondary: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
  },
  danger: {
    backgroundColor: "#FFF4F4",
    borderColor: "#F3C8C8",
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.45,
  },
  label: {
    fontSize: 15,
    fontWeight: "700",
  },
  primaryLabel: {
    color: "#FFFFFF",
  },
  secondaryLabel: {
    color: theme.colors.textPrimary,
  },
});
