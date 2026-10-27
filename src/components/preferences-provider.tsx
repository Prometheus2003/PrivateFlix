"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import {
  defaultPreferences,
  preferencesSchema,
  type Preferences,
} from "@/lib/validation/preferences";
import { ownerApi, OwnerApiError } from "@/client/api";
const Context = createContext({
  preferences: defaultPreferences,
  setPreferences: (_value: Preferences) => {
    void _value;
  },
  loaded: false,
  error: "",
});
export const usePreferences = () => useContext(Context);
export function PreferencesProvider({
  children,
  onUnauthorized,
}: {
  children: ReactNode;
  onUnauthorized: () => void;
}) {
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void ownerApi("/api/settings", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
    })
      .then((result) => {
        const parsed = z
          .object({ preferences: preferencesSchema })
          .parse(result);
        if (!controller.signal.aborted) {
          setPreferences(parsed.preferences);
          setLoaded(true);
        }
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof OwnerApiError && failure.status === 401)
          onUnauthorized();
        else
          setError(
            "Saved preferences could not be loaded. Refresh the page to retry.",
          );
      });
    return () => controller.abort();
  }, [onUnauthorized]);
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [preferences.theme]);
  return (
    <Context.Provider value={{ preferences, setPreferences, loaded, error }}>
      {children}
    </Context.Provider>
  );
}
