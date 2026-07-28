import { evaluateIdleSession } from '@/lib/ac2/idleSession';

const IDLE_TIMEOUT = 60000;

function baseInput(overrides: Partial<Parameters<typeof evaluateIdleSession>[0]> = {}) {
  const now = 1_000_000_000;
  return {
    now,
    lastInboundAt: now - 1000,
    lastLocalAt: now - 1000,
    idleTimeoutMs: IDLE_TIMEOUT,
    userStopped: false,
    wasBackgrounded: false,
    isNativeChannelOpen: () => false,
    ...overrides,
  };
}

describe('evaluateIdleSession', () => {
  it('does nothing while there is recent activity (inbound or local)', () => {
    expect(evaluateIdleSession(baseInput()).action).toBe('none');
    // Either clock alone keeps the session alive.
    const now = baseInput().now;
    expect(
      evaluateIdleSession(
        baseInput({ lastInboundAt: now - IDLE_TIMEOUT * 10, lastLocalAt: now - 1 }),
      ).action,
    ).toBe('none');
    expect(
      evaluateIdleSession(
        baseInput({ lastInboundAt: now - 1, lastLocalAt: now - IDLE_TIMEOUT * 10 }),
      ).action,
    ).toBe('none');
  });

  it('does not consult the native side while activity is recent', () => {
    const isNativeChannelOpen = jest.fn(() => true);
    evaluateIdleSession(baseInput({ isNativeChannelOpen }));
    expect(isNativeChannelOpen).not.toHaveBeenCalled();
  });

  it('closes a genuine foreground idle as terminal (manual recovery)', () => {
    const now = baseInput().now;
    const isNativeChannelOpen = jest.fn(() => true);
    const verdict = evaluateIdleSession(
      baseInput({
        lastInboundAt: now - IDLE_TIMEOUT - 1,
        lastLocalAt: now - IDLE_TIMEOUT - 1,
        wasBackgrounded: false,
        isNativeChannelOpen,
      }),
    );
    expect(verdict.action).toBe('close-idle');
    // A foreground idle is judged on the clocks alone — no native query.
    expect(isNativeChannelOpen).not.toHaveBeenCalled();
  });

  it('treats an intentional stop as a plain idle close even after backgrounding', () => {
    const now = baseInput().now;
    expect(
      evaluateIdleSession(
        baseInput({
          lastInboundAt: now - IDLE_TIMEOUT - 1,
          lastLocalAt: now - IDLE_TIMEOUT - 1,
          userStopped: true,
          wasBackgrounded: true,
          isNativeChannelOpen: () => true,
        }),
      ).action,
    ).toBe('close-idle');
  });

  it('REFRESHES (not tears down) a backgrounded-stale session whose native channel is still open', () => {
    // Regression: after a LONG background the liveness clocks are hours old
    // (JS timers suspended), and on resume the watchdog interval can fire
    // BEFORE the AppState listener's snapshot reconcile. The native background
    // service kept the peer alive the whole time — killing the session logged
    // "Closing stale connection after background; will reconnect" and forced a
    // full renegotiation of a verifiably healthy connection.
    const now = baseInput().now;
    const hoursOld = now - 3 * 60 * 60 * 1000;
    const verdict = evaluateIdleSession(
      baseInput({
        lastInboundAt: hoursOld,
        lastLocalAt: hoursOld,
        wasBackgrounded: true,
        isNativeChannelOpen: () => true,
      }),
    );
    expect(verdict.action).toBe('refresh');
  });

  it('closes a backgrounded-stale session as recoverable when the native side is dead', () => {
    const now = baseInput().now;
    expect(
      evaluateIdleSession(
        baseInput({
          lastInboundAt: now - IDLE_TIMEOUT - 1,
          lastLocalAt: now - IDLE_TIMEOUT - 1,
          wasBackgrounded: true,
          isNativeChannelOpen: () => false,
        }),
      ).action,
    ).toBe('close-stale');
  });

  it('treats a throwing native query (module unavailable) as a dead native side', () => {
    const now = baseInput().now;
    expect(
      evaluateIdleSession(
        baseInput({
          lastInboundAt: now - IDLE_TIMEOUT - 1,
          lastLocalAt: now - IDLE_TIMEOUT - 1,
          wasBackgrounded: true,
          isNativeChannelOpen: () => {
            throw new Error('native module unavailable');
          },
        }),
      ).action,
    ).toBe('close-stale');
  });
});
