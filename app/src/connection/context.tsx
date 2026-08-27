import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import { connectionConfigStore } from "./config-runtime";
import type { ConnectionConfig } from "./config";

type ConnectionContextValue = {
  config: ConnectionConfig | null;
  loading: boolean;
  saveConfig: (config: ConnectionConfig) => Promise<void>;
  clearConfig: () => Promise<void>;
};

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({ children }: PropsWithChildren) {
  const [config, setConfig] = useState<ConnectionConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    void connectionConfigStore
      .get()
      .then((storedConfig) => {
        if (active) {
          setConfig(storedConfig);
        }
      })
      .catch(() => {
        if (active) {
          setConfig(null);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<ConnectionContextValue>(
    () => ({
      config,
      loading,
      async saveConfig(nextConfig) {
        await connectionConfigStore.set(nextConfig);
        setConfig(nextConfig);
      },
      async clearConfig() {
        await connectionConfigStore.clear();
        setConfig(null);
      },
    }),
    [config, loading],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection() {
  const context = useContext(ConnectionContext);

  if (!context) {
    throw new Error("useConnection must be used inside ConnectionProvider");
  }

  return context;
}
