# Build & Release

CI builds run on **Bitrise** and use **Fastlane** for both platforms. The native
`ios/`/`android/` folders are gitignored — every build runs
`expo prebuild --clean`, so all native config (bundle ID, app name, signing
wiring) is driven from `app.config.js` and the `plugins/` config plugins.

## Model

A single **nightly** pipeline builds both platforms for the production bundle and
publishes them internally:

| Platform | Bundle / identifier       | Delivery                              |
| -------- | ------------------------- | ------------------------------------- |
| iOS      | `app.perawallet.ac2-wallet` | TestFlight (internal testers)         |
| Android  | `app.perawallet.ac2`      | Firebase App Distribution (`ac2-alpha`) |

The iOS autofill extension uses `app.perawallet.ac2-wallet.PasskeyAutofillCredentialProvider`.

There is **no separate release pipeline**. When a nightly build is good, promote
it to production manually:
- **iOS** — in App Store Connect, submit the chosen TestFlight build for App Store review.
- **Android** — promote the Firebase build / upload it to a Play track when ready.

> `app.config.js` still defines `staging`/`development` envs for local use, but CI
> builds with `APP_ENV=production` (set at the app level in `bitrise.yml`).

## Pipeline

Defined in [`bitrise.yml`](../bitrise.yml). The `nightly` pipeline runs one
`build` stage that fans out to the `ios` (macOS) and `android` (Linux) workflows
in parallel. Both `before_run` a shared `_prepare` (clone, install JS + Ruby
deps) and `after_run` the platform build.

Configure a **Bitrise scheduled build** pointing at the `nightly` pipeline for
the nightly run. There are no tag/branch triggers.

### Code signing

- **iOS** — the **Manage iOS code signing** step installs the distribution
  certificate + provisioning profiles for every target (app + autofill
  extension) and configures the project, then Fastlane `gym` builds. Signing is
  automatic via the Bitrise **Apple service connection** (API key) — no `match`,
  no manually managed profiles.
- **Android** — signs with a release keystore wired into the regenerated
  `build.gradle` by `plugins/withAndroidReleaseSigning.js` (decoded from
  `ANDROID_KEYSTORE_BASE64`).

### Versioning

Marketing version comes from `package.json`; the build number is
`$BITRISE_BUILD_NUMBER` (exported as `BUILD_NUMBER`). Fastlane applies both — iOS
via `agvtool` (covers the app + extension targets), Android via the Gradle
injected properties.

### Performance

- Caches: `node_modules`, Ruby gems (`vendor/bundle`), CocoaPods, Xcode
  DerivedData (iOS builds incrementally), Gradle, and a **ccache** for the native
  C++ deps (webrtc, quick-crypto, mmkv, nitro, reanimated).
- Android pins Java 17 and disables the Gradle daemon. JVM heap comes from
  `org.gradle.jvmargs` baked into `gradle.properties` by `expo-build-properties`.

## Fastlane lanes

```
fastlane ios deploy_production       # prebuild iOS must have run first
fastlane android deploy_production
```

Lanes read the version from `package.json` and the build number from
`$BUILD_NUMBER`. iOS builds + uploads to TestFlight (signing assets are installed
beforehand by the Bitrise step); Android builds a release APK and uploads to
Firebase.

## Required Bitrise secrets

### iOS
The Apple **service connection** (API key) is configured in Bitrise settings, not
as a secret — it powers the signing step. Fastlane's TestFlight upload needs the
same App Store Connect API key as secrets:

| Key | What |
| --- | --- |
| `APP_STORE_CONNECT_API_KEY_KEY_ID`    | App Store Connect API key ID |
| `APP_STORE_CONNECT_API_KEY_ISSUER_ID` | App Store Connect API issuer ID |
| `APP_STORE_CONNECT_API_KEY_CONTENT`   | **base64** of the `.p8` key file (`base64 -i AuthKey_XXXX.p8 \| pbcopy`) |

### Android
| Key | What |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64`        | base64 of the release keystore |
| `ANDROID_KEYSTORE_PASSWORD`      | keystore store password (also gates release signing on) |
| `ANDROID_KEY_ALIAS`             | key alias |
| `ANDROID_KEY_PASSWORD`          | key password |
| `FIREBASE_SERVICE_ACCOUNT_BASE64`| base64 of a Firebase service-account JSON with App Distribution access |
| `FIREBASE_APP_ID_ANDROID`        | Firebase Android app ID (e.g. `1:123:android:abc`) |
| `FIREBASE_TESTER_GROUPS`         | (optional) defaults to `ac2-alpha` |

Repo access (incl. private repos) is handled by the Bitrise GitHub App
connection — no SSH key secret needed.

## One-time remote setup (not yet done)

### iOS
1. **Register the App IDs** — Apple Developer portal → Identifiers, and enable
   the capabilities so they match the prebuilt entitlements (the Expo autofill
   plugin puts **AutoFill Credential Provider** on *both* targets):
   - `app.perawallet.ac2-wallet`: **App Groups**, **Associated Domains**,
     **AutoFill Credential Provider**.
   - `app.perawallet.ac2-wallet.PasskeyAutofillCredentialProvider`: **App Groups**,
     **AutoFill Credential Provider**.
   - Create App Group `group.app.perawallet.ac2-wallet` and assign it
     to both.
2. **App Store Connect** — create the app `app.perawallet.ac2-wallet` (name "AC2"), pick
   an SKU. Add an internal TestFlight testing group with your testers.
3. **App Store Connect API key** — Users and Access → Integrations → App Store
   Connect API → generate a key with **App Manager** access; download the `.p8`.
4. Use that key in **two** places (same key):
   - the Bitrise **Apple service connection** (App Settings → *Code signing &
     files* / Workspace → Apple service connection) — for the signing step;
   - the three `APP_STORE_CONNECT_API_KEY_*` secrets — for Fastlane's TestFlight
     upload.

### Android
5. **Firebase** — add an Android app with package `app.perawallet.ac2` (gives you
   `FIREBASE_APP_ID_ANDROID`; no `google-services.json` needed). Create a tester
   group **`ac2-alpha`**. Create a service account with the *Firebase App
   Distribution Admin* role, download its JSON, and `base64` it.
6. **Release keystore:**
   ```sh
   keytool -genkeypair -v -keystore release.keystore -alias ac2 \
     -keyalg RSA -keysize 2048 -validity 10000
   base64 -i release.keystore | pbcopy   # -> ANDROID_KEYSTORE_BASE64
   ```
   Back up the keystore (signing continuity for a future Play Store move).

### Bitrise
7. Add the app, set the secrets above, configure the Apple service connection,
   and add a **scheduled build** targeting the `nightly` pipeline.
8. The `Manage iOS code signing` step reads `BITRISE_PROJECT_PATH` /
   `BITRISE_SCHEME` (`ios/AC2.xcworkspace` / `AC2`, from the production app name
   "AC2"). If the app name changes, update those envs in `bitrise.yml`.

## Local builds

`expo prebuild` without `ANDROID_KEYSTORE_PASSWORD` falls back to debug signing,
so local `pnpm android` / `pnpm ios` are unaffected by the release wiring.
