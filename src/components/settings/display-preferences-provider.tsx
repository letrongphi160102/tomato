'use client';

import * as React from 'react';

import {
  DisplayPreferencesContext,
  type DisplayPreferencesContextValue,
} from '@/components/settings/display-preferences-context';
import {
  buildUiPreferencesSetCookieString,
  type ResolvedUiTheme,
  type UiPreferences,
  type UiThemeMode,
} from '@/lib/ui-preferences';

export interface DisplayPreferencesProviderProps {
  readonly initialPreferences: UiPreferences;
  readonly children: React.ReactNode;
}

function applyDocumentThemeAttributes(
  prefs: UiPreferences,
  systemPrefersDark: boolean,
): ResolvedUiTheme {
  const resolved: ResolvedUiTheme =
    prefs.theme === 'dark' || (prefs.theme === 'system' && systemPrefersDark) ? 'dark' : 'light';

  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset.theme = prefs.theme;
    root.classList.toggle('dark', resolved === 'dark');
    root.classList.toggle('light', prefs.theme === 'light');
    root.style.colorScheme = resolved;
  }

  return resolved;
}

function persistPreferencesCookieOnClient(prefs: UiPreferences): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }
  const isHttps = window.location.protocol === 'https:';
  document.cookie = buildUiPreferencesSetCookieString(prefs, { isHttps });
}

export function DisplayPreferencesProvider({
  initialPreferences,
  children,
}: DisplayPreferencesProviderProps) {
  const [preferences, setPreferences] = React.useState<UiPreferences>(initialPreferences);
  const [systemPrefersDark, setSystemPrefersDark] = React.useState<boolean>(false);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const darkMql = window.matchMedia('(prefers-color-scheme: dark)');
    const syncMediaQuery = () => {
      setSystemPrefersDark(darkMql.matches);
    };

    const timerId = window.setTimeout(syncMediaQuery, 0);
    darkMql.addEventListener('change', syncMediaQuery);

    return () => {
      window.clearTimeout(timerId);
      darkMql.removeEventListener('change', syncMediaQuery);
    };
  }, []);

  React.useEffect(() => {
    applyDocumentThemeAttributes(preferences, systemPrefersDark);
  }, [preferences, systemPrefersDark]);

  const setThemeMode = React.useCallback((mode: UiThemeMode) => {
    setPreferences((prev) => {
      if (prev.theme === mode) {
        return prev;
      }
      const next: UiPreferences = { theme: mode };
      const osDark =
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : false;
      applyDocumentThemeAttributes(next, osDark);
      persistPreferencesCookieOnClient(next);
      return next;
    });
  }, []);

  const resolvedTheme: ResolvedUiTheme =
    preferences.theme === 'dark' || (preferences.theme === 'system' && systemPrefersDark)
      ? 'dark'
      : 'light';

  const contextValue = React.useMemo<DisplayPreferencesContextValue>(
    () => ({
      preferences,
      resolvedTheme,
      setThemeMode,
    }),
    [preferences, resolvedTheme, setThemeMode],
  );

  return (
    <DisplayPreferencesContext.Provider value={contextValue}>
      {children}
    </DisplayPreferencesContext.Provider>
  );
}
