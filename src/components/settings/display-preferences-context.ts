import * as React from 'react';

import {
  DEFAULT_UI_PREFERENCES,
  type ResolvedUiTheme,
  type UiPreferences,
  type UiThemeMode,
} from '@/lib/ui-preferences';

export interface DisplayPreferencesContextValue {
  readonly preferences: UiPreferences;
  readonly resolvedTheme: ResolvedUiTheme;
  readonly setThemeMode: (mode: UiThemeMode) => void;
}

const FALLBACK_CONTEXT_VALUE: DisplayPreferencesContextValue = Object.freeze({
  preferences: DEFAULT_UI_PREFERENCES,
  resolvedTheme: 'light',
  setThemeMode: () => undefined,
});

export const DisplayPreferencesContext =
  React.createContext<DisplayPreferencesContextValue>(FALLBACK_CONTEXT_VALUE);

export function useDisplayPreferences(): DisplayPreferencesContextValue {
  return React.useContext(DisplayPreferencesContext);
}
