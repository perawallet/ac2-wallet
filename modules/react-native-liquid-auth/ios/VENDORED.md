# Vendored native library base — iOS signaling

> Provenance note for the Liquid Auth consolidation (see
> `react-native-liquid-auth/docs/CONSOLIDATION_PLAN.md`, decisions **D1** / **D4**).

The iOS signaling stack under `ios/LiquidAuthSDK/` is **vendored from the original
iOS SDK**, the same way the Android signaling stack is vendored under
`android/.../foundation/algorand/auth/connect/`. `LiquidAuthNativeModule.swift`
in the parent directory wraps these vendored sources (via the shared
`SignalService.shared` singleton) and exposes the same JS API as the Android
module.

|                      |                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------- |
| **Upstream repo**    | `algorandfoundation/liquid-auth-ios`                                                          |
| **Upstream path**    | `Sources/LiquidAuthSDK/`                                                                      |
| **Target commit**    | `384c926d334f69e744b80b6166af3d034970170d` (2025-08-20), branch `chore/consolidation`         |
| **Portion vendored** | Signaling only (the FIDO/WebAuthn portion belongs to `react-native-passkey-autofill`, per D4) |

## Vendored files

Signaling-only subset of `Sources/LiquidAuthSDK/`:

- `SignalService.swift`, `SignalClient.swift`, `PeerApi.swift`,
  `DataChannelDelegate.swift`
- Shared shapes: `LiquidAuthPeerType.swift`, `DataChannelConfig.swift`,
  `LinkError.swift`, `LiquidAuthError.swift`, `Logger.swift`

The FIDO/WebAuthn portion (`AssertionApi`, `AttestationApi`,
`AuthenticatorData`, `Utility`, `auth.request.json`) is intentionally **not**
vendored here — it belongs to `react-native-passkey-autofill` (D4). The
signaling files above have no dependency on that portion.

## Sync direction

**Upstream → vendored copy (one-way).** The vendored files are byte-identical to
the upstream sources at the target commit. The upstream SDK's public interface is
aligned with the shared "top-level signal client" shape:

- `LiquidAuthPeerType` (`.offer` / `.answer`) instead of a raw string
- named `dataChannels: [String: DataChannelConfig]` (defaults to a single
  `liquid` channel)
- channel-labeled callbacks `onMessage(channel, message)` /
  `onStateChange(channel, state)`
- a typed `LinkError` / `LinkErrorReason` and an `onLinkError` callback
- channel-addressed send (`sendMessage(_:to:)`)

## Phase-2 parity additions (captured upstream)

The Phase-2 native API gaps that were first added on Android were also
back-ported **up** into `liquid-auth-ios` (then vendored here), so both platforms
share one contract:

- **`onPresence`** — `SignalClient` forwards the socket `presence` broadcast;
  threaded through `SignalService.connectToPeer(onPresence:)`.
- **`onConnectionStateChange`** — `PeerApi`/`PeerConnectionDelegate` forward ICE
  connection-state changes as uppercase strings matching Android
  (`CONNECTED`/`DISCONNECTED`/`FAILED`/...).
- **`cancel()`** — `SignalService.cancel()` / `SignalClient.cancel()` tear down an
  in-flight negotiation; surfaced as the RN module's `cancel()` (pending
  `connect` rejects with `E_ABORTED`).
- **`onConnected`** — a one-shot `SignalService.connectToPeer(onConnected:)` fires
  when the first channel opens, so the RN `connect` promise resolves on both the
  offerer and responder side.

## Wallet-required API parity (ahead of upstream)

The wallet's native transport also requires three methods already present on
Android but missing from the vendored iOS binding:

- **`request`** — performs the Liquid Auth HTTP ceremony with
  `URLSession.shared`. Socket.IO's default iOS session uses the same
  `HTTPCookieStorage.shared`, so the resulting `connect.sid` authenticates the
  signaling socket.
- **`setActive`** — gates delivery while JavaScript is backgrounded or suspended.
- **`flushQueue`** — replays a bounded native inbound queue after fresh JavaScript
  listeners are wired; `options.queueChannels` controls which channels buffer.

These changes are currently ahead of the upstream package and must be
back-ported before the next re-vendor.

Porting this SDK into this directory (Phase 3 of the consolidation plan) is
**DONE**. Wiring iOS background execution appropriately remains an open question
(see the plan's §8 risks).

## macOS compile verification + a required upstream back-port

The vendored signaling sources were compiled on macOS (Xcode 26.2) for the iOS
Simulator (`arm64`) against WebRTC `120.0.0` (`stasel/WebRTC`, module `WebRTC`,
matching the `WebRTC-lib` pod binary) and Socket.IO `16.1.1` — they now build
clean. This surfaced **one real bug** the byte-identical vendoring had carried
unverified:

- `DataChannelConfig.toRTCConfiguration()` assigned
  `config.channelProtocol`, but `RTCDataChannelConfiguration` has no such member
  — the WebRTC property is named `protocol`, so the assignment now uses the
  backtick-escaped Swift keyword (`` config.`protocol` ``).

> **⚠️ Divergence from upstream — back-port required.** This one-line fix makes
> the vendored copy differ from `liquid-auth-ios@384c926`. To keep the one-way
> (upstream → copy) sync direction, the same fix must be applied **upstream** in
> `liquid-auth-ios` (per **D7**); until then this file is intentionally ahead of
> its upstream by this fix.

## Full ExpoModulesCore module compile (macOS)

Beyond the standalone SDK compile above, the **whole native module** — the
`LiquidAuthNative` pod (`LiquidAuthNativeModule.swift` + all vendored
`LiquidAuthSDK/*.swift`) — was compiled through the real Expo/CocoaPods pipeline
on macOS (Xcode 26.2). The `example/` app was linked to the local
module (`"react-native-liquid-auth": "link:.."`), `expo prebuild -p ios`
generated the native project, `pod install` resolved `LiquidAuthNative` +
`ExpoModulesCore` + `Socket.IO-Client-Swift` + `WebRTC-lib`, and `xcodebuild`
(iOS Simulator `arm64`) built the target with `BUILD SUCCEEDED`, 0 errors — no
further source fixes were needed.

> **Toolchain note.** Node/pnpm are not on `PATH` here; the JetBrains-IDE-managed
> `node v24.14.1` / `pnpm 10.33.0` was used. A transitive Expo dependency
> (`expo-modules-jsi@57.0.3`) fails to compile under this machine's
> Xcode 26.2 / Swift 6.2.3 toolchain — an Expo-toolchain issue unrelated to this
> module — and was worked around only in disposable `node_modules` to let the
> build graph reach the `LiquidAuthNative` target.
