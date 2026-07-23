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

## Notification presenter seam (kept in sync, upstream → copy)

`SignalService.handleMessages` gained an optional `NotificationPresenter`
parameter (`(label, message) -> NotificationContent?`, `null` suppresses) plus
the top-level `NotificationContent` / `NotificationPresenter` declarations, so
the *content* of a backgrounded per-message notification is decided by the
consumer (the RN module builds a presenter from `connect(options.notifications)`)
rather than hardcoded in the shared library. With no presenter the legacy
raw-message behavior is preserved. These are byte-for-byte the same additions in
`liquid-auth-android`, `react-native-liquid-auth`, and the wallet's vendored copy
(only the two pre-existing comment lines in `liquid-auth-android`'s
`handleMessages` doc differ).

## Survive-app-close & offline message queue (kept in sync, upstream → copy)

`SignalService` was extended so the connection survives the app being closed and
so requests are delivered when the app comes back online:

- **Lifecycle:** `onStartCommand` returns `START_STICKY` and `onTaskRemoved`
  keeps the service alive (does not `stopSelf`), so the started foreground
  service outlives the app's task. The RN module now only *unbinds* on JS
  `OnDestroy` (`unbindOnly`); the service is stopped solely by an explicit
  `disconnect()`.
- **Offline queue:** a generic message buffer (`messageQueue`) + app-controlled
  online flag. `setActive(active)` (exposed to JS) flips the flag and, when set
  active, replays buffered messages to the current sink in arrival order.
  `handleMessages` gained a `queueChannels: Set<String>?` parameter (which
  labels to buffer while offline; `null` = all). `onUnbind` nulls the stale sink
  so buffered messages are never replayed to a dead listener, and `drainQueue`
  is exception-safe (a throwing sink stops the drain, keeping the rest queued).

The library stays label-agnostic — it never inspects message contents and the
consumer passes the channel labels — keeping `liquid` pure while the app controls
the signaling delivery state. Byte-for-byte identical across the three trees
(only the two pre-existing `handleMessages` doc-comment lines in
`liquid-auth-android` differ).
