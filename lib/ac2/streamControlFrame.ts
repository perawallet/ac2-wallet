/**
 * Factory for the `ac2-stream` control-frame handler used by `useConnection`.
 *
 * A control frame is an out-of-band STX-prefixed message on the stream channel
 * (see `lib/ac2/stream.ts`) that drives agent presence, streamed previews,
 * durable tool cards, advertised conversations and replayed history — it is
 * never rendered as a chat message. The returned function applies one frame and
 * reports whether `raw` was a control frame (recognized or malformed).
 */
import { normalizeNoticeFrame, parseStreamControlFrame } from '@/lib/ac2';
import type { ConnectionNotice } from '@/lib/ac2';
import { addMessage, addToolActivity, addTaskActivity, setThreadHistory } from '@/stores/messages';
import { updateSessionActivity } from '@/stores/sessions';
import type { MutableRefObject } from 'react';

export type AgentPresence = 'thinking' | 'tool' | 'typing' | null;

export interface RemoteThread {
  thid: string;
  title?: string;
  updatedAt?: number;
}

export interface ControlFrameContext {
  origin: string;
  requestId: string;
  addressRef: MutableRefObject<string | null>;
  activeThidRef: MutableRefObject<string>;
  lastInboundActivityRef: MutableRefObject<number>;
  setAgentPresence: (presence: AgentPresence) => void;
  setAgentPresenceDetail: (detail: string | null) => void;
  setActiveStreamText: (text: string) => void;
  setLastHeartbeat: (at: number) => void;
  setRemoteThreads: (threads: RemoteThread[]) => void;
  /**
   * Surface an out-of-band advisory the agent pushed (e.g. a locked/new-wallet
   * warning) as a banner. `null` clears it.
   */
  setConnectionNotice: (notice: ConnectionNotice | null) => void;
}

export function createControlFrameHandler(ctx: ControlFrameContext): (raw: string) => boolean {
  const {
    origin,
    requestId,
    addressRef,
    activeThidRef,
    lastInboundActivityRef,
    setAgentPresence,
    setAgentPresenceDetail,
    setActiveStreamText,
    setLastHeartbeat,
    setRemoteThreads,
    setConnectionNotice,
  } = ctx;

  return (raw: string): boolean => {
    const parsed = parseStreamControlFrame(raw);
    if (parsed === null) return false;
    // Any inbound control frame means the agent is alive — reset the
    // inactivity watchdog so a long "thinking" turn is never torn down.
    lastInboundActivityRef.current = Date.now();
    if (parsed === undefined) return true; // malformed payload, swallow
    const frame: any = parsed;
    const fthid: string =
      typeof frame?.thid === 'string' && frame.thid.length > 0 ? frame.thid : activeThidRef.current;
    const isActiveThread = fthid === activeThidRef.current;
    switch (frame?.t) {
      case 'preview': {
        // Live draft for `fthid`; only reflect it in the on-screen UI
        // when it belongs to the conversation currently open.
        if (isActiveThread) {
          if (frame.phase === 'tool') {
            setAgentPresence('tool');
            setAgentPresenceDetail(typeof frame.detail === 'string' ? frame.detail : null);
          } else if (frame.phase === 'typing') {
            setAgentPresence('typing');
            setAgentPresenceDetail(null);
          } else {
            // `thinking` (and any unknown phase) → thinking indicator.
            setAgentPresence('thinking');
            setAgentPresenceDetail(null);
          }
          if (typeof frame.text === 'string') setActiveStreamText(frame.text);
        }
        break;
      }
      case 'finalize': {
        // Commit the streamed draft in place as the agent's message for
        // its thread; clear the live preview if it's the active thread.
        const text = typeof frame.text === 'string' ? frame.text.trim() : '';
        if (text && addressRef.current) {
          addMessage({
            text,
            sender: 'peer',
            address: addressRef.current,
            origin,
            requestId,
            thid: fthid,
          });
          updateSessionActivity(requestId, origin);
          setLastHeartbeat(Date.now());
        }
        if (isActiveThread) {
          setActiveStreamText('');
          setAgentPresence(null);
          setAgentPresenceDetail(null);
        }
        break;
      }
      case 'discard': {
        if (isActiveThread) {
          setActiveStreamText('');
          setAgentPresence(null);
          setAgentPresenceDetail(null);
        }
        break;
      }
      case 'conversations': {
        if (Array.isArray(frame.threads)) {
          // The agent advertised the conversations it already holds for
          // this connection. Surface them so the controller can show
          // (and restore) threads it has no local copy of.
          setRemoteThreads(
            frame.threads
              .filter((t: any) => typeof t?.thid === 'string' && t.thid.length > 0)
              .map((t: any) => ({
                thid: t.thid as string,
                ...(typeof t.title === 'string' ? { title: t.title } : {}),
                ...(typeof t.updatedAt === 'number' ? { updatedAt: t.updatedAt } : {}),
              })),
          );
        }
        break;
      }
      case 'tool': {
        // Durable tool-activity card: a record of one tool/exec step the
        // agent ran. Persist it (de-duped by the agent-supplied id) so it
        // renders as a distinct "tool card" in the thread's timeline,
        // independent of the ephemeral `preview` (phase tool) indicator.
        if (typeof frame.id === 'string' && addressRef.current) {
          addToolActivity({
            toolId: frame.id,
            address: addressRef.current,
            origin,
            requestId,
            thid: fthid,
            ...(typeof frame.name === 'string' ? { tool: frame.name } : {}),
            ...(typeof frame.command === 'string' ? { command: frame.command } : {}),
            ...(typeof frame.output === 'string' ? { output: frame.output } : {}),
          });
          updateSessionActivity(requestId, origin);
        }
        break;
      }
      case 'task': {
        // Durable background-task card: a record of one background sub-agent run.
        // Persist it (de-duped by the agent-supplied id) so it renders as a
        // distinct "task card" in the thread's timeline.
        if (typeof frame.id === 'string' && addressRef.current) {
          addTaskActivity({
            taskId: frame.id,
            address: addressRef.current,
            origin,
            requestId,
            thid: fthid,
            ...(typeof frame.title === 'string' ? { title: frame.title } : {}),
            ...(typeof frame.prompt === 'string' ? { prompt: frame.prompt } : {}),
            ...(typeof frame.status === 'string' ? { status: frame.status } : {}),
            ...(typeof frame.result === 'string' ? { result: frame.result } : {}),
          });
          updateSessionActivity(requestId, origin);
        }
        break;
      }
      case 'notice': {
        // Out-of-band advisory (never a chat bubble): surface it as a banner so
        // the user is alerted even though the agent isn't replying in-thread.
        // Used for the "a different wallet is connecting" lock warning.
        const notice = normalizeNoticeFrame(frame);
        if (notice) setConnectionNotice(notice);
        break;
      }
      case 'history': {
        if (typeof frame.thid === 'string' && Array.isArray(frame.messages) && addressRef.current) {
          // The agent replayed an existing conversation's history (e.g.
          // after we opened/switched to it). Restore it into the local
          // store, idempotently replacing our copy of that thread.
          const history = frame.messages
            .filter(
              (m: any) =>
                (m?.role === 'user' ||
                  m?.role === 'assistant' ||
                  m?.role === 'tool' ||
                  m?.role === 'task') &&
                (typeof m?.text === 'string' || m?.role === 'tool' || m?.role === 'task'),
            )
            .map((m: any) => {
              if (m.role === 'tool') {
                // A persisted tool/exec card replayed by the agent — carry
                // through its id (so it coalesces with live frames) and
                // tool/command/output fields.
                return {
                  role: 'tool' as const,
                  text: '',
                  ...(typeof m.id === 'string' ? { toolId: m.id } : {}),
                  ...(typeof m.name === 'string' ? { tool: m.name } : {}),
                  ...(typeof m.command === 'string' ? { command: m.command } : {}),
                  ...(typeof m.output === 'string' ? { output: m.output } : {}),
                  ...(typeof m.at === 'number' ? { at: m.at } : {}),
                };
              }
              if (m.role === 'task') {
                return {
                  role: 'task' as const,
                  text: '',
                  ...(typeof m.id === 'string' ? { id: m.id } : {}),
                  ...(typeof m.title === 'string' ? { title: m.title } : {}),
                  ...(typeof m.prompt === 'string' ? { prompt: m.prompt } : {}),
                  ...(typeof m.status === 'string' ? { status: m.status } : {}),
                  ...(typeof m.result === 'string' ? { result: m.result } : {}),
                  ...(typeof m.at === 'number' ? { at: m.at } : {}),
                };
              }
              return {
                role: m.role as 'user' | 'assistant',
                text: m.text as string,
                ...(typeof m.at === 'number' ? { at: m.at } : {}),
              };
            });
          setThreadHistory(addressRef.current, origin, requestId, frame.thid, history);
        }
        break;
      }
      default:
        break;
    }
    return true;
  };
}
