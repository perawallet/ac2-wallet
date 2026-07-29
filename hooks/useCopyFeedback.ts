/**
 * Copy-to-clipboard feedback shared by the screens that expose tappable
 * detail rows (Profile overlay, Credentials screen) so the two behave the
 * same way.
 */

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as React from 'react';
import { AccessibilityInfo, Alert, Platform } from 'react-native';

// Android shows its own on-screen confirmation when something is written to
// the clipboard, so our toast would be a duplicate there. iOS gives no such
// feedback, which is the only reason we render one at all.
const showsNativeCopyFeedback = () => Platform.OS !== 'ios';

const COPIED_RESET_MS = 1500;

export function useCopyFeedback() {
  const [copiedField, setCopiedField] = React.useState<string | null>(null);
  const copyResetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    },
    [],
  );

  const copy = React.useCallback(async (field: string, value: string) => {
    if (!value || value === '—') return;

    try {
      const didCopy = await Clipboard.setStringAsync(value);
      if (!didCopy) throw new Error('Clipboard did not accept the value');
    } catch {
      setCopiedField(null);
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
      copyResetTimer.current = null;
      Alert.alert('Copy failed', 'Could not copy to the clipboard.');
      return;
    }

    setCopiedField(field);
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopiedField(null), COPIED_RESET_MS);

    if (!showsNativeCopyFeedback()) {
      AccessibilityInfo.announceForAccessibility('Copied to clipboard');
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, []);

  return {
    /** Field key of the most recent copy, for the inline row checkmark. */
    copiedField,
    copy,
    /** Whether to render our own toast — iOS only, see above. */
    showCopiedToast: copiedField !== null && !showsNativeCopyFeedback(),
  };
}
