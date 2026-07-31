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

## Sync direction (one-way: upstream → copy)

This is a **one-way mirror**. The upstream repo is the source of truth. Do not
make behavioral edits to the native Kotlin/Swift or the `src/` TypeScript here;
change upstream first, then re-vendor. Consistent with the vendor-a-copy
convention (consolidation decisions D1/D7).

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
  and same Clang module (`WebRTC`). CocoaPods refuses two same-named vendored
  frameworks in one target — it aborts with "frameworks with conflicting
  names" — so the wallet can host exactly one. Depending on the
  app's existing `JitsiWebRTC` shares that single binary — and inherits
  react-native-webrtc's version pin, where upstream's `WebRTC-lib` was
  unpinned and free to drift off the app's M124. The vendored SDK only uses
  standard `RTCPeerConnection` / `RTCDataChannel` / ICE APIs (verified — it
  compiles against Jitsi M124), so this is safe. Do **not** back-port upstream;
  it is a consumption-side adjustment specific to this wallet.

The podspec's `s.platforms` is left at upstream's 16.4. It is only safe to
leave it there because the wallet sets `ios.deploymentTarget: '17.0'`
(`app.config.js`, via `expo-build-properties`) — expo autolinking **silently
skips** a pod whose deployment target exceeds the app's platform, so on the
previous 15.1 floor the 16.4 kept this module out of the build entirely (see
"Known caveat"). If the wallet's deployment target is ever lowered below 16.4,
lower this podspec to match or the module will silently vanish from the iOS
binary again. Nothing in the vendored Swift actually requires 16.4 — there are
no `@available` annotations, the imports are only `CoreImage` /
`ExpoModulesCore` / `Foundation` / `SocketIO` / `WebRTC`, and the highest
dependency minimum is ExpoModulesCore's 15.1 — so lowering it is safe if needed.

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

**iOS (resolved):** two independent problems kept `LiquidAuthNative` out of the
iOS binary, surfacing at runtime as `Cannot find native module
'LiquidAuthNative'` → `SERVICE_FAILED (kind=auth)`, because the Metro alias
makes the JS `require` succeed on every platform regardless of what is built.

1. **The podspec's 16.4 platform exceeded the app's then-15.1 floor.** Expo
   autolinking _skips_ such pods with a single yellow warning rather than
   failing, so `pod install` reported success while quietly omitting the module
   — no pod in `Podfile.lock`, no entry in `ExpoModulesProvider.swift`. See
   `expo-modules-autolinking/scripts/ios/autolinking_manager.rb`.
2. **`WebRTC-lib` collided with `JitsiWebRTC`** once the pod was installable.

(1) is fixed by the wallet's `ios.deploymentTarget: '17.0'`, which clears 16.4;
(2) by the podspec's `JitsiWebRTC` divergence. The two are independent —
raising the deployment target alone turns the silent skip into a hard
`pod install` failure (verified: `The 'Pods-AC2Debug' target has frameworks with
conflicting names: webrtc.xcframework`), because the pod only reaches the
collision once it is no longer skipped. `pod install` now reports `Installing
LiquidAuthNative 1.0.0` and the module is registered in
`ExpoModulesProvider.swift`. Note this needs a **native rebuild**; a Metro
reload cannot pick it up.

The older framing of this caveat — that the clash is only resolved once the
in-process WebRTC path is retired — was too pessimistic: sharing the app's
WebRTC binary resolves it today. Retiring that path (Phase 4 cleanup) is still
worth doing, but it is no longer a prerequisite for an iOS build.

## Upgrade path (removing this copy)

When the package is published to a registry, this is a small, mechanical change:
delete `modules/react-native-liquid-auth/`, drop the Metro alias +
`tsconfig`/`oxlint`/`oxfmt`/Jest isolation entries, and add a normal scoped
dependency (e.g. `@algorandfoundation/react-native-liquid-auth`).
