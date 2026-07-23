# Vendored native library base — Android signaling

> Provenance note for the Liquid Auth consolidation (see
> `react-native-liquid-auth/docs/CONSOLIDATION_PLAN.md`, decision **D1**).

This `foundation.algorand.auth.connect` package is a **vendored copy** of the
signaling / WebRTC stack from the original Android SDK.

| | |
| --- | --- |
| **Upstream repo** | `algorandfoundation/liquid-auth-android` |
| **Upstream path** | `liquid/src/main/java/foundation/algorand/auth/connect/` |
| **Copied from commit** | `05b51f2609c15c8daa74848ce83f4a1fad397a85` (2026-03-07) |
| **Portion vendored** | Signaling only (`SignalService`, `SignalClient`, `PeerApi`, `AuthMessage`, `SignalInterface`, extensions) |

## Sync direction

**Upstream → vendored copy (one-way).** Edit the originals in
`liquid-auth-android` first, then sync the change *down* into this copy. Do not
treat this copy as the source of truth.

## Local divergence

This copy had evolved beyond the `05b51f2` upstream commit to support the React
Native binding (multiple named data channels, media-track surfacing,
channel-labeled message/state callbacks, `send(label, msg)`).

**Divergence captured upstream (consolidation branch `chore/consolidation`).**
Those evolutions have now been back-ported *into the upstream originals* so the
originals and this vendored copy expose the same "top-level signal client"
contract (peer type, named data channels, channel-labeled callbacks,
channel-addressed send). The upstream SDK kept its own extras that this copy
does not need (Hilt `@Inject` DI on `SignalClient`, ML Kit `Barcode` parsing in
`AuthMessage`); those are intentionally **not** mirrored here.

As a result the two trees are aligned again and future upstream → copy syncs no
longer have to re-derive the multi-channel / track additions. Keep the public
method/callback shapes aligned with the shared contract shared with the JS
client (`@algorandfoundation/liquid-client`) and the iOS SDK
(`liquid-auth-ios`).

## Phase 2 additions (kept in sync, upstream → copy)

The native API gaps the wallet needs (consolidation **Phase 2**) were added to
the upstream originals **and** mirrored here in the same change set, preserving
the one-way sync direction:

- `SignalClient.onPresence` / `onLinkError` — forward the signaling socket's
  `presence` broadcast and `exception` (link-error) events.
- `SignalClient.onConnectionStateChange` (wired to `PeerApi.onConnectionStateChange`)
  — surface ICE connection-state changes.
- `SignalClient.cancel()` / `SignalService.cancel()` — abort an in-flight
  negotiation (fails the pending continuation with a `CancellationException`).

These are byte-for-byte the same additions in both trees; only the upstream's
`@Inject` constructor on `SignalClient` differs (not mirrored here).
