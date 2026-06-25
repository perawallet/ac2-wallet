/* eslint-disable @typescript-eslint/no-require-imports */
const { withAndroidManifest } = require('expo/config-plugins');

/**
 * @type {import('expo/config-plugins').ConfigPlugin}
 *
 * Strips the media-read permissions that `expo-screen-capture` contributes via
 * its library manifest. We only use screenshot *prevention*
 * (ScreenCapture.preventScreenCaptureAsync -> FLAG_SECURE, see
 * lib/runtime/screenshot-manager.ts), which needs no permission. The library
 * also declares READ_MEDIA_IMAGES (Android 13) and READ_EXTERNAL_STORAGE
 * (<= Android 12) for its screenshot *detection* API (addScreenshotListener),
 * which we do not call. Google Play flags READ_MEDIA_IMAGES as a sensitive
 * photo/video permission, so we remove both here.
 *
 * Removal works by adding `tools:node="remove"` entries to the app's main
 * AndroidManifest; the Gradle manifest merger then drops the library-provided
 * permissions from the final merged manifest.
 *
 * NOTE: DETECT_SCREEN_CAPTURE (Android 14+) is intentionally left in place — it
 * is not a sensitive permission and is the path we'd use if/when we add
 * screenshot detection on modern devices. If screenshot detection on Android 13
 * is ever required, remove this plugin and complete the Play photo/video
 * permissions declaration.
 */
const PERMISSIONS_TO_REMOVE = [
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_EXTERNAL_STORAGE',
];

const withRemoveMediaPermissions = (config) => {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    // Ensure the tools namespace is available for tools:node="remove".
    manifest.$ = manifest.$ || {};
    manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

    const existing = manifest['uses-permission'] || [];

    // Drop any direct declarations of these permissions, then add explicit
    // remove directives so the merger also strips library-contributed copies.
    const filtered = existing.filter(
      (perm) => !PERMISSIONS_TO_REMOVE.includes(perm?.$?.['android:name']),
    );

    for (const name of PERMISSIONS_TO_REMOVE) {
      filtered.push({ $: { 'android:name': name, 'tools:node': 'remove' } });
    }

    manifest['uses-permission'] = filtered;
    return config;
  });
};

module.exports = withRemoveMediaPermissions;
