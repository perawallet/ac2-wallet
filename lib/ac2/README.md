# AC2 controller

This Expo / React-Native app is the **controller / wallet** side of the
[AC2](https://github.com/algorandfoundation/ac2-sdk) protocol. It pairs
with the reference plugin in
[`ac2-open-claw-reference`](https://github.com/algorandfoundation/ac2/tree/master/packages/ac2-open-claw-reference),
which is the **agent** side hosted in OpenClaw.

## What the controller contributes to AC2

| AC2 surface                                        | Where it lives in this app                                |
| -------------------------------------------------- | --------------------------------------------------------- |
| Liquid Auth + WebRTC pairing                       | `lib/ac2/transport.ts` (`createAc2Transport`)             |
| `Ac2Client` wiring + envelope mirror               | `lib/ac2/client.ts` (`createAc2Client`)                   |
| `SigningRequest` approve/reject                    | `hooks/useAc2Responders.ts` + `lib/ac2/responders.ts`     |
| `KeyRequest` approve/reject (agent identity grant) | `hooks/useAc2Responders.ts` + `stores/agentIdentities.ts` |
| Multi-conversation control plane                   | `lib/ac2/conversations.ts` + `lib/ac2/threads.ts`         |
| Stream-channel control frames (`ac2-stream`)       | `lib/ac2/stream.ts`                                       |
| Heartbeat side channel (`ac2-heartbeat`)           | `lib/ac2/heartbeat.ts`                                    |
| AC2 message timeline (UI)                          | `app/chat.tsx`                                            |
| Connection list / sessions                         | `app/connections.tsx` + `stores/sessions.ts`              |

The hook `hooks/useConnection.ts` composes all of the above behind a
single React-facing surface that `app/chat.tsx` and `app/connections.tsx`
consume.

## Stores that carry AC2 state

- `stores/messages.ts` — free-text chat per conversation thread.
- `stores/ac2Messages.ts` — validated DIDComm v2 envelopes (the signing
  trio + any other `AC2BaseMessage`).
- `stores/agentIdentities.ts` — Ed25519 identity keys the wallet has
  granted to AC2 agents in response to a bootstrap `KeyRequest`.
- `stores/sessions.ts` — persisted connection list (origin + requestId).

## Entry points in `lib/ac2/*`

- `transport.ts` — Liquid Auth `SignalClient` + `peer()` + DataChannel
  negotiation (`ac2-v1`, `ac2-stream`, `ac2-heartbeat`).
- `client.ts` — wraps the control DataChannel with the SDK's transport
  adapter and mirrors inbound envelopes into `ac2MessagesStore`.
- `responders.ts` — pure builders for `SigningResponse`,
  `SigningRejected`, and `KeyResponse` envelopes.
- `conversations.ts` — `ac2/ConversationOpen` / `ConversationClose`
  sender + active `thid` bookkeeping.
- `stream.ts` — STX-prefixed control-frame parser for `ac2-stream`
  (`preview` / `finalize` / `discard` / `conversations` / `tool` /
  `history` / `notice`). A `notice` frame is an out-of-band advisory
  (`normalizeNoticeFrame`) rendered by `components/chat/ConnectionNoticeBanner.tsx`
  as a dismissible banner — e.g. the agent's "a different wallet is
  connecting and cannot take over" warning. The banner is scoped to the
  connection it was raised on (`selectConnectionNoticeForRequest` matches the
  stored `requestId`), so it disappears when the user switches to another
  connection — which may be a new registration or a previously-paired wallet.
  A subset of notice codes (`isRegistrationBlockingNotice` —
  `controller_locked` and `identity_missing`) also means the wallet is **not
  registered** with the agent: `hooks/useConnection.ts` tracks this per
  connection and exposes `isRegistered`. While not registered the connection is
  made **inert** — `send`, `sendAc2`, and `openConversation` are hard-blocked in
  `useConnection` (not just the disabled composer), so nothing can be sent over
  a connection that wasn't paired properly. `ChatScreen` also prompts the user
  to delete the connection (re-pairing generates a new `requestId`, so the old
  one is dead).
- `heartbeat.ts` — `ac2-heartbeat` channel handlers.

## Message flow at a glance

1. User scans the QR rendered by the OpenClaw plugin → Liquid Auth
   signaling + WebRTC pairing (`lib/ac2/transport.ts`).
2. Agent sends a bootstrap `ac2/KeyRequest`; the wallet mints a fresh
   Ed25519 identity key, persists it (`stores/agentIdentities.ts`), and
   returns `ac2/KeyResponse` (`hooks/useAc2Responders.ts`).
3. Agent calls `ac2_sign` on its side; the wallet receives an
   `ac2/SigningRequest`, prompts the user, signs with the active
   account, and returns `ac2/SigningResponse` (or `SigningRejected`).
4. Free-text chat + tool/preview frames flow on `ac2-stream`; liveness
   on `ac2-heartbeat`.
5. If a *different* wallet connects to an already-registered agent, the
   agent refuses the takeover (it will not reuse or regenerate its key)
   and pushes a `notice` frame; the wallet shows the banner explaining
   the operator must clear the agent's keys (`ac2 forget`) before a new
   wallet can register. The banner belongs to that connection's
   `requestId` and clears automatically when a different connection is
   opened. While the wallet is not registered (locked out, or no identity
   granted yet) the connection is inert — the composer is disabled and
   `send`/`sendAc2`/`openConversation` are hard-blocked — and the app prompts
   the user to delete the connection, since re-pairing generates a new
   `requestId`.

For the agent-side counterpart see
[`ac2-open-claw-reference`](https://github.com/algorandfoundation/ac2/tree/master/packages/ac2-open-claw-reference).
