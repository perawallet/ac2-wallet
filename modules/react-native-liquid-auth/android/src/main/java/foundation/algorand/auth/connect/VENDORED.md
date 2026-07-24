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

## Heartbeat keep-alive (kept in sync, upstream → copy)

While the app is offline the JS heartbeat ping/pong reply (in the wallet's
`lib/ac2/heartbeat.ts` and its interval sender) is dead, so the peer's
liveness watchdog would stop seeing pongs and close the p2p connection even
though the foreground service is still alive. To fix this `SignalService`
gained an optional `HeartbeatConfig(channel, ping, pong)` (top-level data class)
and a `handleMessages(..., heartbeat)` parameter: in the offline branch, when an
inbound frame on `channel` equals `ping`, the service replies `pong` on the same
channel natively (and neither queues nor notifies for it). With no config the
behavior is disabled (legacy). The RN module builds it from
`connect(options.heartbeat)` and the wallet passes
`{ channel: "ac2-heartbeat", ping: "ping", pong: "pong" }`, so the shared
library never hardcodes channel labels or tokens. Byte-for-byte identical
across the three trees (only the two pre-existing `handleMessages`
doc-comment lines in `liquid-auth-android` differ).

## Stale channel-close fix (kept in sync, upstream → copy)

`PeerApi.destroy()` now **unregisters each data channel's observer before
closing it**. Closing a channel drives it to `CLOSING`/`CLOSED`, and a
still-registered observer reports that state through the module-wide
`onStateChange` sink — which is keyed only by channel **label**. When a previous
peer is torn down while a NEW negotiation for the same labels (e.g. `ac2-v1`) is
already live (e.g. on the reconnect/relaunch after killing the app, where
`SignalService.start()` re-inits the client and `SignalClient.disconnect()`
destroys the old peer), those stale `CLOSED` events were mis-delivered to the
new channel's shim and closed a healthy connection — surfacing in the wallet as
`Data channel closed` → `Connection lost (channel)` immediately after the
channels opened. Detaching the observer first makes a destroyed peer go silent,
so only the current negotiation's real state changes reach JS. Byte-for-byte
identical across `liquid-auth-android`, `react-native-liquid-auth`, and the
wallet's vendored copy.
## Preserve live connection + re-attach + resume-on-tap (kept in sync, upstream → copy)

Three related changes so the background service *stays connected* while the app
re-attaches (rather than restarting) and the connected banner reopens the app in
place:

- **`start()` preserves the live client.** It no longer `disconnect()`s and
  rebuilds `SignalClient` when one already exists — it only builds a client when
  there is none (first start / after an explicit `disconnect()`/`stop()`). So the
  app calling `start()` again on relaunch/foreground does NOT tear down the live
  peer the service was keeping alive.
- **`getConnectionState()` + `attach(...)`.** `getConnectionState()` returns a
  read-only snapshot (`connected`, `requestId`, `iceConnectionState`, per-channel
  `channels`) so a re-attaching app can hydrate instead of assuming a fresh
  start. `attach(...)` rebinds the socket/peer callbacks to the fresh JS runtime,
  re-registers the data-channel observers (via `handleMessages`) and re-emits the
  current channel + ICE state (observers only fire on transitions, so a
  live-but-unchanged channel is re-announced explicitly). `peer()` records the
  bound `requestId`; `stop()` clears it.
- **`createPendingIntent` resumes the task.** It now builds a
  `FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_SINGLE_TOP` intent (via
  `PendingIntent.getActivity`) instead of `TaskStackBuilder`, whose implicit
  `FLAG_ACTIVITY_CLEAR_TASK` cleared the task and relaunched a fresh activity —
  which reset the JS runtime (the app "opened fresh", losing state) and, with
  expo-router, produced the "linking configured in multiple places" error from
  two concurrent NavigationContainers. With the activity's `singleTask`
  launchMode, tapping the banner now resumes the running instance and preserves
  its state.

Byte-for-byte identical across `liquid-auth-android`, `react-native-liquid-auth`,
and the wallet's vendored copy (only the two pre-existing `createPendingIntent`/
`handleMessages` doc-comment lines in `liquid-auth-android` differ).

## Notification status model & hydrate message-replay buffering (2026-07-23)

Applied two fixes for robust connection hydrate and stateful notifications:

- **Notification status:** the `NotificationPresenter` was replaced by a stateful `NotificationStatus` (connected/idle/messages). The single ongoing notification now reflects the service state natively while the app is backgrounded, updating to "Tap to open" when closed idle and "You have new messages" when messages arrived while closed.
- **RTC shim buffering:** the `NativeDataChannel` (TS shim) now buffers inbound messages until a consumer (`onmessage` or a `message` listener) is attached. This ensures that the background service's offline-queue replay during `attach()` is not dropped if the SDK client hasn't wired the channel handlers yet.
- **RTC shim deferred flush:** the RTC shim `NativeDataChannel` now flushes its buffered offline-replay on a MICROTASK (deferred) rather than synchronously when `onmessage`/a `message` listener is attached, and buffers live frames while a flush is pending to preserve arrival order — this fixes replayed messages being dropped because the AC2 SDK's `rtcDataChannelTransport` assigns `onmessage` before registering its real inbound handlers. Applied byte-identically across the wallet's `lib/ac2` (runtime source of truth), the package `src`, and the vendored module `src` (D7).
- **`attach()` marks the app active (2026-07-23):** `SignalService.attach(...)` now sets `appActiveOverride = true` up front (before `handleMessages` captures the fresh sink) so the offline-queue replay on hydrate always runs. Previously the replay depended on the consumer's `setActive(true)` timing, and a late/racing `onUnbind` from the previous binding (torn down on relaunch) could reset `appActiveOverride` to `null` after the app went online, causing `handleMessages` to skip `drainQueue()` and strand every message buffered while the app was closed. Ported byte-identically to the package copy and upstream `liquid-auth-android` (D7; upstream keeps only its pre-existing KDoc differences).

Byte-for-byte identical across the upstream `liquid-auth-android` (SignalService), the `react-native-liquid-auth` package, and the wallet's vendored copy (D7).

## Consumer-driven offline-queue replay (`flushQueue`, 2026-07-23)

`setActive(true)` no longer auto-replays the offline queue, and the service
gained a public `flushQueue()` (exposed as `Function("flushQueue")` on the RN
module) so the CONSUMER decides when the replay fires.

Why: the JS VM can survive an app relaunch (the next "Running main" reuses the
same process/runtime), and the previous session's channel shims + native
message listeners are intentionally preserved across a swipe-away (so the live
peer isn't torn down). On relaunch the app calls `setActive(true)` during
socket setup — BEFORE the fresh transport wires its listeners — so the
auto-replay fired into the previous session's stale handlers, which silently
drop everything (their run is marked inactive). The buffered messages were
consumed and lost; the fresh session saw nothing.

Now the replay only happens when a fresh sink attaches (`handleMessages` via
`connect`/`attach`, unchanged) or when the consumer explicitly calls
`flushQueue()` once its listeners are wired. The wallet calls it (a) after a
transport negotiation completes (all channel consumers wired) and (b) on a
background → foreground transition while a live transport exists (same-runtime
handlers still valid). The wallet also detaches the dead tree's native
listeners/monitors in its preserve-path cleanups so stale sessions can't
swallow or duplicate future replays.

Ported byte-identically across `liquid-auth-android`, the
`react-native-liquid-auth` package, and the wallet's vendored copy (upstream
keeps only its pre-existing KDoc differences; the wallet's vendored copy
additionally carries temporary debug logging).
