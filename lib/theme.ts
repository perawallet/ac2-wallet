import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';

// Imperative color values for RN props that don't accept className
// (e.g. ActivityIndicator `color`, icon `color`). This is a SUBSET — only the
// colors needed imperatively; global.css CSS variables are the authoritative
// source, so keep these hex values in sync with the matching --token there.
export const THEME = {
  light: {
    background: '#F7F7FF',
    foreground: '#1C1B3A',
    card: '#FFFFFF',
    primary: '#5858F0',
    mutedForeground: '#656483',
    border: '#DADAF7',
  },
  dark: {
    background: '#101025',
    foreground: '#F7F7FF',
    card: '#1A1A36',
    primary: '#8585F4',
    mutedForeground: '#9897BE',
    border: '#35345B',
  },
} as const;

export const NAV_THEME: { light: Theme; dark: Theme } = {
  light: {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: THEME.light.background,
      border: THEME.light.border,
      card: THEME.light.card,
      notification: THEME.light.primary,
      primary: THEME.light.primary,
      text: THEME.light.foreground,
    },
  },
  dark: {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      background: THEME.dark.background,
      border: THEME.dark.border,
      card: THEME.dark.card,
      notification: THEME.dark.primary,
      primary: THEME.dark.primary,
      text: THEME.dark.foreground,
    },
  },
};
