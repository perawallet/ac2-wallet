# Vendored: react-native-liquid-auth (Expo local module)

This directory is a **vendored copy** of the `react-native-liquid-auth` package,
consumed by `ac2-wallet` as an [Expo local module](https://docs.expo.dev/modules/get-started/#creating-the-local-expo-module)
under `modules/`. It exists so the wallet is a self-contained, buildable app
without a pnpm workspace, a published package, or an externally checked-out
sibling repo.

## Provenance

- **Upstream repo:** https://github.com/algorandfoundation/react-native-liquid-auth
- **Upstream commit:** `1b5d4ca7dc69b11c13a44e0a7696a877eff2a0bc` (`chore: bind connections to service`)
- **Vendored on:** 2026-07-23
- **Re-synced on:** 2026-07-24 — persistent signaling socket (peer-only
  `cancel()` that no longer tears the socket down) and the new
  `onSignalingStateChange` event / `signalingConnected` snapshot field, applied
  from the upstream working tree alongside the same wallet-side changes.
- **Re-synced on:** 2026-07-24 (later same day) — cached `lastPresence` on the
  persistent socket (Android/iOS `SignalClient`), exposed via
  `getConnectionState()` (Android/iOS `SignalService`, TS
  `LiquidAuthConnectionState.lastPresence`, web stub), applied from the
  upstream working tree. Lets a launching wallet learn its peer is offline
  from the room-join presence broadcast that fires before the JS listener
  attaches.

## Sync direction (normally upstream → copy)

This is a **one-way mirror**. The upstream repo is the source of truth. Do not
make behavioral edits to the native Kotlin/Swift or the `src/` TypeScript here;
change upstream first, then re-vendor. Consistent with the vendor-a-copy
convention (consolidation decisions D1/D7).

> **Temporary iOS parity divergence — upstream back-port required.** The wallet
> calls `request`, `setActive`, and `flushQueue` on every native transport setup,
> but the vendored iOS module did not export them. The local Swift binding now
> implements the same API as Android: authenticated HTTP through the shared iOS
> cookie store, app-active delivery gating, and bounded inbound-message replay.
> Port these changes to `react-native-liquid-auth` upstream before the next
> re-vendor so they are not overwritten.

### Intentional local divergence (build config only, not behavior)

- **`android/build.gradle` — WebRTC is `compileOnly`.** Upstream declares
  `implementation "io.getstream:stream-webrtc-android:1.1.3"` so the standalone
  package ships its own `org.webrtc.*`. In this wallet, `react-native-webrtc`
  already ships the same `org.webrtc` API (`org.jitsi:webrtc:124.+`), so two
  implementations on the app classpath fail the Android build with
  `Duplicate class org.webrtc.*` (63 collisions). The dependency is changed to
  `compileOnly` here so the module compiles against `org.webrtc` but the app's
  WebRTC provides those classes at runtime. The module only imports standard
  `org.webrtc.*` types (verified), so this is safe. Do **not** back-port this
  upstream — the standalone package still needs `implementation`; it is a
  consumption-side adjustment specific to the wallet (which also depends on
  `react-native-webrtc`).

- **`ios/LiquidAuthNative.podspec` — WebRTC is `JitsiWebRTC`.** The iOS analog
  of the Android divergence above, and for the same reason. Upstream declares
  `WebRTC-lib`, which vendors a `WebRTC.xcframework`; `react-native-webrtc`
  pulls `JitsiWebRTC ~> 124.0.0`, which vendors a framework of the _same name_
  and same Clang module (`WebRTC`). CocoaPods allows only one in the app target.
  Depending on the app's existing `JitsiWebRTC` shares that binary and keeps
  the version aligned with `react-native-webrtc`.

- **`ios/LiquidAuthNative.podspec` — platform is `15.1`, not `16.4`.** Upstream
  declares 16.4, inherited from liquid-auth-ios' passkey /
  `AuthenticationServices` code that this vendored subset does not include.
  The vendored signaling subset has no 16.4-only API, and its highest dependency
  minimum is ExpoModulesCore's 15.1. Expo autolinking skips a pod whose minimum
  deployment target exceeds the app target, so the upstream value kept the
  native module out of this wallet's iOS binary.

## What was copied / trimmed

Copied from upstream (verbatim):

- `src/` — JS/TS API (`index.ts`, `LiquidAuthNativeModule.ts`, `.web.ts`,
  `LiquidAuthNative.types.ts`, `nativeChannel.ts`). Consumed directly by Metro;
  there is **no `build/` step** for a local module.
- `android/` — Kotlin native module + gradle (autolinked from `modules/`).
- `ios/` — Swift native module + `LiquidAuthNative.podspec` + vendored
  `LiquidAuthSDK/` (autolinked from `modules/`).
- `expo-module.config.json` — declares the native module for autolinking.
- `LICENSE`.

Excluded (not needed to build/consume as a local module):

- `node_modules/`, `build/`, `example/`, `internal/`, `pnpm-lock.yaml`, `.git`.
- The upstream `src/__tests__/` (the package's own Jest suite).

The `package.json` here is **trimmed**: `main`/`types` point at `src/index.ts`
(Metro bundles the TypeScript directly), and build scripts / devDependencies /
lockfile are dropped. `name`, `version`, and `peerDependencies` are kept so Expo
autolinking still discovers the module.

## How the wallet reaches it

The bare specifier `react-native-liquid-auth` is mapped to
`modules/react-native-liquid-auth/src` via a Metro resolver alias
(`metro.config.js`), so every existing `require('react-native-liquid-auth')` /
import resolves unchanged. The vendored tree is excluded from the wallet's
`tsc`, `oxlint`, and `oxfmt` (and scoped in Jest via `moduleNameMapper`).

## Known caveat

**Android (resolved):** the module's `org.webrtc` provider (`stream-webrtc-android`)
collided with the wallet's `react-native-webrtc` (`org.jitsi:webrtc`), failing
`expo run:android` / `:app:assembleDebug` with `Duplicate class org.webrtc.*`.
Fixed by declaring the module's WebRTC dependency `compileOnly` (see "Intentional
local divergence" above) — `:app:assembleDebug` now `BUILD SUCCESSFUL`.

**iOS (resolved):** two independent podspec problems kept `LiquidAuthNative`
out of the iOS binary:

1. The podspec's iOS 16.4 minimum exceeded the app's 15.1 target, so Expo
   autolinking skipped the pod.
2. Once installable, `WebRTC-lib` collided with the same-named WebRTC framework
   already supplied by `JitsiWebRTC` through `react-native-webrtc`.

The local podspec now targets iOS 15.1 and shares the app's `JitsiWebRTC`
dependency. A native prebuild/rebuild is required; a Metro reload cannot add a
previously omitted native module to an installed binary.

## Upgrade path (removing this copy)

When the package is published to a registry, this is a small, mechanical change:
delete `modules/react-native-liquid-auth/`, drop the Metro alias +
`tsconfig`/`oxlint`/`oxfmt`/Jest isolation entries, and add a normal scoped
dependency (e.g. `@algorandfoundation/react-native-liquid-auth`).
