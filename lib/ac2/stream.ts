/**
 * STX-prefixed control-frame parser for the `ac2-stream` side channel.
 * Decodes the finalizer-driven live-preview protocol (preview / finalize /
 * discard / conversations / tool / history / notice) the agent sends.
 */

/** STX byte that prefixes every control frame on the stream channel. */
export const STX = 0x02;

export type AgentPresence = 'thinking' | 'tool' | 'typing' | null;

/** Severity of an out-of-band `notice` control frame. */
export type NoticeLevel = 'info' | 'warning' | 'error';

/**
 * An out-of-band advisory the agent pushed (e.g. a locked/new-wallet warning).
 * Rendered as a banner in the chat surface, never as a chat bubble.
 */
export interface ConnectionNotice {
  /** Machine-readable code so the UI can special-case a notice. */
  code: string;
  level: NoticeLevel;
  title?: string;
  text: string;
}

/**
 * A {@link ConnectionNotice} tagged with the connection (`requestId`) it was
 * raised on. The chat surface is reused across connection switches, so a notice
 * is stored scoped to its connection to prevent one wallet's banner from
 * bleeding onto another.
 */
export interface ScopedConnectionNotice {
  notice: ConnectionNotice;
  requestId: string;
}

/**
 * Resolve which notice (if any) should be shown for the connection currently on
 * screen. Returns the stored notice only when it belongs to `requestId`;
 * otherwise `null` — starting a new connection (a new registration or a
 * previously-paired wallet reconnecting) has a different `requestId`, so the
 * banner disappears. Pure, so it is trivially unit-testable.
 */
export function selectConnectionNoticeForRequest(
  scoped: ScopedConnectionNotice | null,
  requestId: string,
): ConnectionNotice | null {
  if (!scoped) return null;
  return scoped.requestId === requestId ? scoped.notice : null;
}

/**
 * Notice codes that mean the wallet is not registered with the agent and must
 * not be allowed to send new messages:
 * - `controller_locked` — a *different* wallet connected to an agent already
 *   registered to another one (the agent refuses to switch).
 * - `identity_missing` — the agent has not been granted an identity yet.
 * The agent surfaces both as banner-only notices; the wallet uses these codes
 * to gate the composer until registration completes.
 */
export const REGISTRATION_BLOCKING_NOTICE_CODES: ReadonlySet<string> = new Set([
  'controller_locked',
  'identity_missing',
]);

/**
 * Whether a notice `code` indicates the wallet is not registered, so the chat
 * composer must be blocked. Pure, so it is trivially unit-testable.
 */
export function isRegistrationBlockingNotice(code: string | undefined | null): boolean {
  return typeof code === 'string' && REGISTRATION_BLOCKING_NOTICE_CODES.has(code);
}

export type StreamControlFrame =
  | {
      t: 'preview';
      thid?: string;
      phase?: 'thinking' | 'tool' | 'typing';
      detail?: string;
      text?: string;
    }
  | { t: 'finalize'; thid?: string; text?: string }
  | { t: 'discard'; thid?: string }
  | { t: 'conversations'; threads?: Array<{ thid: string; title?: string; updatedAt?: number }> }
  | { t: 'tool'; thid?: string; id?: string; name?: string; command?: string; output?: string }
  | {
      t: 'task';
      thid?: string;
      id?: string;
      title?: string;
      status?: string;
      prompt?: string;
      result?: string;
    }
  | { t: 'history'; thid?: string; messages?: any[] }
  | { t: 'notice'; code?: string; level?: NoticeLevel; title?: string; text?: string }
  | { t: string; [k: string]: unknown };

const NOTICE_LEVELS: ReadonlySet<string> = new Set(['info', 'warning', 'error']);

/**
 * Normalize a `notice` control frame into a `ConnectionNotice`, or return
 * `null` when it carries no displayable text. Kept pure (no store/UI deps) so
 * it is trivially unit-testable. `level` defaults to `warning`; an unknown
 * level is coerced to `warning` too.
 */
export function normalizeNoticeFrame(frame: unknown): ConnectionNotice | null {
  if (typeof frame !== 'object' || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (f['t'] !== 'notice') return null;
  const text = typeof f['text'] === 'string' ? f['text'].trim() : '';
  if (text.length === 0) return null;
  const level =
    typeof f['level'] === 'string' && NOTICE_LEVELS.has(f['level'])
      ? (f['level'] as NoticeLevel)
      : 'warning';
  const code = typeof f['code'] === 'string' && f['code'].length > 0 ? f['code'] : 'notice';
  const title = typeof f['title'] === 'string' && f['title'].length > 0 ? f['title'] : undefined;
  return { code, level, text, ...(title ? { title } : {}) };
}

/**
 * Parse a raw DataChannel string as a control frame. Returns `null` if `raw`
 * is not a control frame (no STX prefix) and `undefined` if it parsed but
 * the payload was malformed JSON (still a control frame, swallowed).
 */
export function parseStreamControlFrame(raw: string): StreamControlFrame | null | undefined {
  if (typeof raw !== 'string' || raw.charCodeAt(0) !== STX) return null;
  try {
    return JSON.parse(raw.slice(1)) as StreamControlFrame;
  } catch {
    return undefined;
  }
}
