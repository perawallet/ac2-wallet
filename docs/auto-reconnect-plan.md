# Auto-reconnect plan for AC2 chat sessions

## Problem

When the user closes the app and comes back, an AC2 chat connection that has
dropped requires them to manually hit the **Reconnect** button. This is not an
ideal flow. We want the app to automatically attempt to reconnect, with a small
number of rate-limited retries, and only fall back to the manual Reconnect
button once those retries are exhausted.

## Current state

- `hooks/useConnection.ts` owns the connection lifecycle: initial setup, manual
  `reconnect()`, error state, heartbeat/inactivity watchdogs, and transport
  teardown (`clearTransport`).
- `components/chat/ChatScreen.tsx` swaps between the composer, a disabled
  "Connecting…" composer (`isLoading`), and `ReconnectBar` based on
  `isConnected` / `isLoading`.
- `components/chat/ReconnectBar.tsx` is the current terminal fallback UI shown
  once the hook stops retrying.
- `stores/sessions.ts` persists sessions (via MMKV) so the last connection can
  be restored after relaunch; `app/(tabs)/chat.tsx` restores the last session
  selection on launch.
- There is currently **no `AppState` usage** anywhere, so a backgrounded app
  that loses its transport has no automatic resume path — an already-mounted
  `useConnection` instance is never told to retry when the app is foregrounded.

## Implementation plan

### 1. Add an explicit reconnect state machine in `useConnection`

- Track:
  - auto-retry attempt count
  - whether a reconnect is currently in progress
  - whether the current reconnect is automatic vs. manual
  - whether the hook is waiting on a backoff timer
- Distinguish transient "still retrying" states from terminal/manual states so
  the UI can keep showing a reconnecting state while retries are in flight.

### 2. Add bounded, rate-limited automatic retries

- Retry on transport close (`onClose`) and recoverable setup failures.
- Cap automatic retries at **3 attempts**.
- Use a small backoff (e.g. 1s -> 2s -> 4s, capped) so we don't hammer the
  agent/server.
- Reset the retry budget after a successful connection or a user-initiated
  manual reconnect.

### 3. Trigger reconnect when the app returns to the foreground

- Add an `AppState` listener (in `useConnection`, since that hook owns the
  lifecycle).
- On transition back to `active`, if the session exists but the transport is
  down and we are not already connecting/retrying, kick off the automatic
  reconnect flow.
- Guard against duplicate retries while an auth flow or transport setup is
  already in progress (`authFlowInProgressRef`, `clientRef`).

### 4. Adjust the chat UI to reflect retry progress

- Keep the composer disabled with a "Connecting…"/"Reconnecting…" state while
  auto-retries are still underway.
- Only show `ReconnectBar` after the retry budget is exhausted, so the button
  becomes the final fallback instead of the first response.
- Optionally surface lightweight status text such as "Reconnecting (2/3)".

### 5. Preserve current session behavior

- Keep persisted sessions in `stores/sessions.ts` as the source for restoring
  the last connection after relaunch.
- Do not change the **Disconnect** / **Forget** flows so explicit user intent
  still stops auto-reconnect.
- Ensure the inactivity shutdown and deliberate `reset()` do not immediately
  trigger an unwanted auto-reconnect loop.

### 6. Test the behavior

- Add/update tests around the connection lifecycle with fake timers:
  - retries up to 3 times, then stops
  - a successful reconnect resets the retry budget
  - foregrounding the app triggers reconnect when disconnected
  - manual disconnect/reset does not auto-reconnect
- Add a UI-level test if practical to verify the reconnect button only appears
  after retries are exhausted.

## Files most likely involved

- `hooks/useConnection.ts` (state machine, retries, `AppState` wiring)
- `components/chat/ChatScreen.tsx` (UI state selection)
- `components/chat/ReconnectBar.tsx` (final fallback copy/behavior)
- `__tests__/` (lifecycle + UI tests)
