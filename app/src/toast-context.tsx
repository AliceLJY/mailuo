import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { ApiError } from "@/api";
import { theme } from "@/theme";

type ToastTone = "error" | "info";

type ToastEntry = {
  id: number;
  message: string;
  tone: ToastTone;
};

type ToastContextValue = {
  showToast: (message: string, tone?: ToastTone) => void;
  showError: (error: unknown, fallback?: string) => void;
  dismissToast: () => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: PropsWithChildren) {
  const [toast, setToast] = useState<ToastEntry | null>(null);

  const dismissToast = useCallback(() => {
    setToast(null);
  }, []);

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  const showError = useCallback(
    (error: unknown, fallback = "请求失败，请稍后再试。") => {
      if (error instanceof ApiError) {
        showToast(error.message, "error");
        return;
      }

      if (error instanceof Error) {
        showToast(error.message, "error");
        return;
      }

      showToast(fallback, "error");
    },
    [showToast],
  );

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeoutId = setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, 3500);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [toast]);

  const value = useMemo<ToastContextValue>(
    () => ({
      dismissToast,
      showError,
      showToast,
    }),
    [dismissToast, showError, showToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <View pointerEvents="box-none" style={styles.viewport}>
          <Pressable
            accessibilityRole="button"
            onPress={dismissToast}
            style={[
              styles.toast,
              toast.tone === "error" ? styles.errorToast : styles.infoToast,
            ]}
          >
            <Text style={styles.title}>
              {toast.tone === "error" ? "出错了" : "提示"}
            </Text>
            <Text style={styles.message}>{toast.message}</Text>
          </Pressable>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error("useToast must be used inside ToastProvider");
  }

  return context;
}

const styles = StyleSheet.create({
  viewport: {
    left: 16,
    position: "absolute",
    right: 16,
    top: 18,
    zIndex: 100,
  },
  toast: {
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
  },
  errorToast: {
    backgroundColor: "#FFF4F4",
    borderColor: "#F3C8C8",
  },
  infoToast: {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.primaryBorder,
  },
  title: {
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 4,
  },
  message: {
    color: theme.colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
});
