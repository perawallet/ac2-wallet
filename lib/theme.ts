import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';

// Imperative color values for RN props that don't accept className
// (e.g. ActivityIndicator `color`, icon `color`). This is a SUBSET — only the
// colors needed imperatively; global.css CSS variables are the authoritative
// source, so keep these hex values in sync with the matching --token there.
export const THEME = {
  light: {
    background: '#F4F5FB',
    foreground: '#0F172A',
    card: '#FFFFFF',
    primary: '#5858F0',
    mutedForeground: '#64748B',
    border: '#E2E8F0',
  },
  dark: {
    background: '#0B111E',
    foreground: '#F8FAFC',
    card: '#161D2C',
    primary: '#5858F0',
    mutedForeground: '#94A3B8',
    border: '#283549',
  },
} as const;

export const NAV_THEME: { light: Theme; dark: Theme } = {
  light: {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: THEME.light.background,
      primary: THEME.light.primary,
    },
  },
  dark: {
    ...DarkTheme,
    colors: { ...DarkTheme.colors, background: THEME.dark.background, primary: THEME.dark.primary },
  },
};
