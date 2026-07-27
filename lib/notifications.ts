/**
 * Notification permission helpers.
 *
 * The Liquid Auth connection runs inside a native foreground service
 * (`react-native-liquid-auth`) that shows an ongoing "connected" notification
 * plus per-message notifications while the app is backgrounded. Since Android
 * 13 (API 33) `POST_NOTIFICATIONS` is a *runtime* permission: declaring it in
 * the manifest is not enough — the app must request it and the user must grant
 * it, or the service runs silently with no notifications. `expo-notifications`
 * requests the platform permission (`POST_NOTIFICATIONS` on Android, the
 * user-notification authorization on iOS).
 */

import * as Notifications from 'expo-notifications';

/**
 * Ensure the runtime notification permission is granted, requesting it once if
 * it can still be asked for. Non-fatal: returns `false` (rather than throwing)
 * when the permission is unavailable/denied, so the caller can proceed — the
 * background service still runs, just without visible notifications.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    // Already permanently denied (user chose "Don't allow"): don't nag.
    if (!current.canAskAgain) return false;
    const requested = await Notifications.requestPermissionsAsync();
    return requested.granted;
  } catch (err) {
    console.warn('[ac2] Failed to request notification permission', err);
    return false;
  }
}
