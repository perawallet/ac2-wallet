import type { NativeDataChannel } from '@/lib/ac2/nativeChannel';
import {
  AC2_CONTROL_CHANNEL,
  addNativeSignalingStateListener,
  createNativeAc2Transport,
  flushNativeQueue,
  isSnapshotChannelOpen,
  type LiquidAuthNativeApi,
  nativeAuthFetch,
  presenceFromSnapshot,
  type NativeSignalingStateEvent,
} from '@/lib/ac2/nativeTransport';

/** Flush pending microtasks so awaited `start()`/`connect()` progress. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

interface FakeNative {
  api: LiquidAuthNativeApi;
  emitMessage: (channel: string, message: string) => void;
  emitState: (channel: string, state: string | null) => void;
  emitConnection: (state: string) => void;
  emitPresence: (e: { requestId: string; deviceCount: number; online: boolean }) => void;
  emitLinkError: (e: { reason?: string; message?: string }) => void;
  resolveConnect: () => void;
  rejectConnect: (err: Error) => void;
  setConnectionState: (s: {
    connected: boolean;
    requestId: string | null;
    iceConnectionState: string | null;
    channels: Record<string, string>;
  }) => void;
  sent: Array<[string, string]>;
  activeMessageListeners: () => number;
}

function createFakeNative(): FakeNative {
  const message = new Set<(e: any) => void>();
  const state = new Set<(e: any) => void>();
  const conn = new Set<(e: any) => void>();
  const presence = new Set<(e: any) => void>();
  const link = new Set<(e: any) => void>();
  const sent: Array<[string, string]> = [];

  let resolveConnect: () => void = () => {};
  let rejectConnect: (err: Error) => void = () => {};
  let connectionState = {
    connected: false,
    requestId: null as string | null,
    iceConnectionState: null as string | null,
    channels: {} as Record<string, string>,
  };

  const sub = (set: Set<(e: any) => void>, l: (e: any) => void) => {
    set.add(l);
    return { remove: () => set.delete(l) };
  };
  const emit = (set: Set<(e: any) => void>, e: any) => {
    for (const l of set) l(e);
  };

  const api: LiquidAuthNativeApi = {
    start: jest.fn(async () => {}),
    connect: jest.fn(
      () =>
        new Promise<void>((res, rej) => {
          resolveConnect = res;
          rejectConnect = rej;
        }),
    ),
    cancel: jest.fn(async () => {}),
    getConnectionState: jest.fn(() => connectionState),
    attach: jest.fn(async () => {}),
    setActive: jest.fn(() => {}),
    flushQueue: jest.fn(() => {}),
    sendToChannel: jest.fn((channel: string, m: string) => {
      sent.push([channel, m]);
    }),
    disconnect: jest.fn(async () => {}),
    addMessageListener: (l) => sub(message, l),
    addStateChangeListener: (l) => sub(state, l),
    addConnectionStateListener: (l) => sub(conn, l),
    addPresenceListener: (l) => sub(presence, l),
    addLinkErrorListener: (l) => sub(link, l),
    request: jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK', body: '' })),
  };

  return {
    api,
    emitMessage: (channel, m) => emit(message, { channel, message: m }),
    emitState: (channel, s) => emit(state, { channel, state: s }),
    emitConnection: (s) => emit(conn, { state: s }),
    emitPresence: (e) => emit(presence, e),
    emitLinkError: (e) => emit(link, e),
    resolveConnect: () => resolveConnect(),
    rejectConnect: (err) => rejectConnect(err),
    setConnectionState: (s: typeof connectionState) => {
      connectionState = s;
    },
    sent,
    activeMessageListeners: () => message.size,
  };
}

describe('createNativeAc2Transport', () => {
  it('starts the service, negotiates as answerer, and resolves once ac2-v1 opens', async () => {
    const fake = createFakeNative();
    const sideChannels: NativeDataChannel[] = [];
    const onPeerConnection = jest.fn();

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: (c) => sideChannels.push(c),
      onPeerConnection,
    });

    await flush();

    expect(fake.api.start).toHaveBeenCalledWith('https://signal.example');
    const connectArgs = (fake.api.connect as jest.Mock).mock.calls[0];
    expect(connectArgs[0]).toBe('req-1');
    expect(connectArgs[1]).toBe('answer');
    expect(connectArgs[3].dataChannels).toHaveProperty(AC2_CONTROL_CHANNEL);
    // Deliverable channels are buffered natively while the app is offline;
    // pure control (`ac2-heartbeat`) is intentionally excluded.
    expect(connectArgs[3].queueChannels).toEqual(['ac2-v1', 'ac2-stream']);

    // Heartbeat keep-alive is enabled by default so the native service answers
    // the agent's `ping` with a `pong` while the app is backgrounded (the JS
    // ping/pong reply is dead then), keeping the connection from being torn
    // down by the agent's liveness watchdog.
    expect(connectArgs[3].heartbeat).toEqual({
      channel: 'ac2-heartbeat',
      ping: 'ping',
      pong: 'pong',
    });

    // Side channels are surfaced before negotiation completes.
    expect(sideChannels.map((c) => c.label).sort()).toEqual(['ac2-heartbeat', 'ac2-stream']);

    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');
    fake.resolveConnect();
    const setup = await promise;

    expect(setup.datachannel.label).toBe(AC2_CONTROL_CHANNEL);
    expect(setup.datachannel.readyState).toBe('open');
    expect(onPeerConnection).toHaveBeenCalledWith(setup.peerConnection);
  });

  it('re-attaches (no renegotiation) when the service already holds a live connection for the requestId', async () => {
    const fake = createFakeNative();
    fake.setConnectionState({
      connected: true,
      requestId: 'req-1',
      iceConnectionState: 'CONNECTED',
      channels: { 'ac2-v1': 'OPEN', 'ac2-stream': 'OPEN', 'ac2-heartbeat': 'OPEN' },
    });

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: () => {},
    });

    await flush();

    // The live connection is re-attached, not renegotiated — and the healthy
    // peer is never cancelled out from under the attach.
    expect(fake.api.attach).toHaveBeenCalledTimes(1);
    expect(fake.api.connect).not.toHaveBeenCalled();
    expect(fake.api.cancel).not.toHaveBeenCalled();

    // attach() re-emits the current channel state so the control channel opens.
    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');
    const setup = await promise;
    expect(setup.datachannel.readyState).toBe('open');
  });

  it('delivers offline-queue messages replayed during attach() to a consumer wired AFTER setup (hydrate)', async () => {
    const fake = createFakeNative();
    fake.setConnectionState({
      connected: true,
      requestId: 'req-1',
      iceConnectionState: 'CONNECTED',
      channels: { 'ac2-v1': 'OPEN' },
    });

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: () => {},
    });

    await flush();
    expect(fake.api.attach).toHaveBeenCalledTimes(1);

    // The native service drains its offline queue during attach()/handleMessages,
    // BEFORE the SDK client wires the control channel's `onmessage` (which only
    // happens after this factory resolves). The replayed control-plane message
    // therefore arrives with no consumer attached yet.
    fake.emitMessage(AC2_CONTROL_CHANNEL, 'queued-while-closed');
    // attach() then re-emits the live channel state so the control channel opens.
    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');

    const setup = await promise;

    // The SDK client wires the consumer only now (post-resolve).
    const raw: string[] = [];
    setup.datachannel.onmessage = (ev) => {
      if (typeof ev.data === 'string') raw.push(ev.data);
    };

    // The deferred flush replays the buffered message once the consumer attaches.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(raw).toEqual(['queued-while-closed']);
  });

  it('renegotiates (not attach) when the live connection is for a different requestId', async () => {
    const fake = createFakeNative();
    fake.setConnectionState({
      connected: true,
      requestId: 'other-req',
      iceConnectionState: 'CONNECTED',
      channels: { 'ac2-v1': 'OPEN' },
    });

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: () => {},
    });

    await flush();
    expect(fake.api.attach).not.toHaveBeenCalled();
    expect(fake.api.connect).toHaveBeenCalledTimes(1);

    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');
    fake.resolveConnect();
    await promise;
  });

  it("never attaches in 'connect' mode: the held peer is cancelled and renegotiated", async () => {
    const fake = createFakeNative();
    // The service still reports a perfectly healthy-looking peer for this
    // requestId — which is exactly the zombie the machine is recovering from
    // when it asks for `connect`. Attaching to it would silently reinstate the
    // dead link instead of forcing a fresh negotiation.
    fake.setConnectionState({
      connected: true,
      requestId: 'req-1',
      iceConnectionState: 'CONNECTED',
      channels: { 'ac2-v1': 'OPEN', 'ac2-stream': 'OPEN', 'ac2-heartbeat': 'OPEN' },
    });

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      mode: 'connect',
      native: fake.api,
      onSideChannel: () => {},
    });

    await flush();
    expect(fake.api.attach).not.toHaveBeenCalled();
    // The lingering peer is force-cancelled first: left in place it keeps the
    // ICE session to the agent alive, so the agent ignores the fresh offer.
    expect(fake.api.cancel).toHaveBeenCalledTimes(1);
    expect(fake.api.connect).toHaveBeenCalledTimes(1);

    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');
    fake.resolveConnect();
    await promise;
  });

  it.each([
    ['the control channel is not open', 'CONNECTED', { 'ac2-v1': 'CLOSED' }],
    ['ICE has failed', 'FAILED', { 'ac2-v1': 'OPEN' }],
  ])('renegotiates in attach mode when %s', async (_case, ice, channels) => {
    const fake = createFakeNative();
    fake.setConnectionState({
      connected: true,
      requestId: 'req-1',
      iceConnectionState: ice,
      channels,
    });

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: () => {},
    });

    await flush();
    expect(fake.api.attach).not.toHaveBeenCalled();
    expect(fake.api.connect).toHaveBeenCalledTimes(1);

    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');
    fake.resolveConnect();
    await promise;
  });

  it('cancels a zombie peer the strict snapshot rejects (connected: false, dead ICE) before the fresh offer', async () => {
    const fake = createFakeNative();
    // The stricter native `connected` turns false as soon as ICE dies — even
    // while the service still holds the peer object. That zombie must still
    // be destroyed before a fresh negotiation: skipping the cancel leaks the
    // old peer on Android and lets its dying transitions fire label-keyed
    // events into the NEW session's shims.
    fake.setConnectionState({
      connected: false,
      requestId: 'req-1',
      iceConnectionState: 'FAILED',
      channels: { 'ac2-v1': 'OPEN' },
    });
    let resolveCancel: () => void = () => {};
    (fake.api.cancel as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveCancel = res;
        }),
    );

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: () => {},
    });

    await flush();
    // The cancel is AWAITED: no fresh offer until the native teardown settles.
    expect(fake.api.cancel).toHaveBeenCalledTimes(1);
    expect(fake.api.attach).not.toHaveBeenCalled();
    expect(fake.api.connect).not.toHaveBeenCalled();

    resolveCancel();
    await flush();
    expect(fake.api.connect).toHaveBeenCalledTimes(1);

    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');
    fake.resolveConnect();
    await promise;
  });

  it('still cancels (a native no-op) when the service holds no peer at all', async () => {
    const fake = createFakeNative();
    // Default snapshot: connected false, no requestId, no channels — nothing
    // to destroy, but the unconditional cancel must not block the connect.
    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: () => {},
    });

    await flush();
    expect(fake.api.cancel).toHaveBeenCalledTimes(1);
    expect(fake.api.connect).toHaveBeenCalledTimes(1);

    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');
    fake.resolveConnect();
    await promise;
  });

  it('does not send a fresh offer when aborted while the zombie cancel is in flight', async () => {
    const fake = createFakeNative();
    fake.setConnectionState({
      connected: false,
      requestId: 'req-1',
      iceConnectionState: 'FAILED',
      channels: {},
    });
    const controller = new AbortController();
    let resolveCancel: () => void = () => {};
    (fake.api.cancel as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveCancel = res;
        }),
    );

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: () => {},
      signal: controller.signal,
    });
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    await flush();
    controller.abort();
    resolveCancel();

    await rejection;
    expect(fake.api.connect).not.toHaveBeenCalled();
  });

  it('routes native messages to the matching channel shim', async () => {
    const fake = createFakeNative();
    const streamFrames: string[] = [];

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: (c) => {
        if (c.label === 'ac2-stream') c.onmessage = (e) => streamFrames.push(e.data);
      },
    });

    await flush();
    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');
    fake.resolveConnect();
    const setup = await promise;

    fake.emitMessage('ac2-stream', 'control-frame');
    expect(streamFrames).toEqual(['control-frame']);

    setup.datachannel.send('outbound');
    expect(fake.sent).toContainEqual([AC2_CONTROL_CHANNEL, 'outbound']);
  });

  it('satisfies the RtcDataChannelLike surface the AC2 SDK client binds to', async () => {
    const fake = createFakeNative();

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: () => {},
    });

    await flush();
    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');
    fake.resolveConnect();
    const setup = await promise;

    // Mirror the exact wiring `rtcDataChannelTransport` performs on the channel
    // (property-style handlers + label/readyState/send), without importing the
    // SDK subpath (unresolvable under this repo's Jest moduleNameMapper).
    const raw: string[] = [];
    let opened = false;
    const channel = setup.datachannel;
    expect(channel.label).toBe(AC2_CONTROL_CHANNEL);
    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string') raw.push(ev.data);
    };
    channel.onopen = () => {
      opened = true;
    };

    fake.emitMessage(AC2_CONTROL_CHANNEL, 'not-json');
    expect(raw).toEqual(['not-json']);

    expect(channel.readyState).toBe('open');
    channel.send('{"hi":true}');
    expect(fake.sent).toContainEqual([AC2_CONTROL_CHANNEL, '{"hi":true}']);
    // `opened` demonstrates the property handler is invocable; the channel was
    // already open before assignment (as it is post-negotiation).
    expect(opened).toBe(false);
  });

  it('forwards presence updates to onPresence', async () => {
    const fake = createFakeNative();
    const onPresence = jest.fn();

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: () => {},
      onPresence,
    });

    await flush();
    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');
    fake.resolveConnect();
    const setup = await promise;

    fake.emitPresence({ requestId: 'req-1', deviceCount: 2, online: true });
    expect(onPresence).toHaveBeenCalledWith({ requestId: 'req-1', deviceCount: 2, online: true });

    setup.disposePresence();
    fake.emitPresence({ requestId: 'req-1', deviceCount: 1, online: true });
    expect(onPresence).toHaveBeenCalledTimes(1);
  });

  it('rejects immediately for an already-aborted signal and never starts', async () => {
    const fake = createFakeNative();
    const controller = new AbortController();
    controller.abort();

    await expect(
      createNativeAc2Transport({
        url: 'https://signal.example',
        requestId: 'req-1',
        native: fake.api,
        onSideChannel: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fake.api.start).not.toHaveBeenCalled();
  });

  it('cancels the native negotiation and detaches listeners on abort', async () => {
    const fake = createFakeNative();
    const controller = new AbortController();

    const promise = createNativeAc2Transport({
      url: 'https://signal.example',
      requestId: 'req-1',
      native: fake.api,
      onSideChannel: () => {},
      signal: controller.signal,
    });

    await flush();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.api.cancel).toHaveBeenCalled();
    expect(fake.activeMessageListeners()).toBe(0);
  });
});

describe('flushNativeQueue', () => {
  it('delegates to the native flushQueue', () => {
    const fake = createFakeNative();
    flushNativeQueue(fake.api);
    expect(fake.api.flushQueue).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the native module does not implement flushQueue (older binary)', () => {
    const fake = createFakeNative();
    delete (fake.api as any).flushQueue;
    expect(() => flushNativeQueue(fake.api)).not.toThrow();
  });
});

describe('isSnapshotChannelOpen', () => {
  const snapshot = (channels: Record<string, string>) => ({
    connected: true,
    requestId: 'req-1',
    iceConnectionState: 'CONNECTED',
    channels,
  });

  it('recognizes the UPPERCASE enum strings the native snapshot carries', () => {
    // Regression: the raw snapshot reports states verbatim (`"OPEN"`), and a
    // lowercase `=== 'open'` check misread a healthy resume as dead — forcing
    // a spurious reconnect on every background -> foreground transition.
    expect(isSnapshotChannelOpen(snapshot({ [AC2_CONTROL_CHANNEL]: 'OPEN' }))).toBe(true);
  });

  it('accepts an already-lowercase state', () => {
    expect(isSnapshotChannelOpen(snapshot({ [AC2_CONTROL_CHANNEL]: 'open' }))).toBe(true);
  });

  it('rejects non-open states regardless of case', () => {
    expect(isSnapshotChannelOpen(snapshot({ [AC2_CONTROL_CHANNEL]: 'CLOSING' }))).toBe(false);
    expect(isSnapshotChannelOpen(snapshot({ [AC2_CONTROL_CHANNEL]: 'closed' }))).toBe(false);
  });

  it('is false when the channel is missing from the snapshot', () => {
    expect(isSnapshotChannelOpen(snapshot({ 'ac2-stream': 'OPEN' }))).toBe(false);
    expect(isSnapshotChannelOpen(snapshot({}))).toBe(false);
  });

  it('checks a custom channel label when given one', () => {
    expect(isSnapshotChannelOpen(snapshot({ 'ac2-stream': 'OPEN' }), 'ac2-stream')).toBe(true);
  });
});

describe('presenceFromSnapshot', () => {
  const snapshot = (lastPresence?: any) => ({
    connected: false,
    requestId: null,
    iceConnectionState: null,
    channels: {},
    lastPresence,
  });

  it('returns the cached presence for the matching requestId', () => {
    // Regression: at a cold launch against an offline peer the room-join
    // `presence` broadcast (deviceCount=1 — just the wallet) fires while the
    // native service is starting, BEFORE the JS listener attaches, and the
    // server then stays silent. Without reading it back from the snapshot the
    // machine's presence gate stayed "unknown" and the wallet negotiated
    // forever into a peer that was not there — never showing the peer-offline
    // notice.
    expect(
      presenceFromSnapshot(snapshot({ requestId: 'req-1', deviceCount: 1, online: true }), 'req-1'),
    ).toEqual({ requestId: 'req-1', deviceCount: 1, online: true });
  });

  it('ignores a cached presence from a DIFFERENT requestId (stale session)', () => {
    expect(
      presenceFromSnapshot(
        snapshot({ requestId: 'req-old', deviceCount: 2, online: true }),
        'req-1',
      ),
    ).toBeNull();
  });

  it('is null when the native side has no cached presence yet (or an older binary)', () => {
    expect(presenceFromSnapshot(snapshot(null), 'req-1')).toBeNull();
    expect(presenceFromSnapshot(snapshot(undefined), 'req-1')).toBeNull();
  });

  it('normalizes a partial payload (missing deviceCount / online)', () => {
    expect(presenceFromSnapshot(snapshot({ requestId: 'req-1' }), 'req-1')).toEqual({
      requestId: 'req-1',
      deviceCount: 0,
      online: false,
    });
    expect(presenceFromSnapshot(snapshot({ requestId: 'req-1', deviceCount: 2 }), 'req-1')).toEqual(
      { requestId: 'req-1', deviceCount: 2, online: true },
    );
  });
});

describe('addNativeSignalingStateListener', () => {
  it('delegates to the native listener and forwards events until removed', () => {
    const listeners = new Set<(e: NativeSignalingStateEvent) => void>();
    const fake = createFakeNative();
    (fake.api as any).addSignalingStateListener = (l: (e: NativeSignalingStateEvent) => void) => {
      listeners.add(l);
      return { remove: () => listeners.delete(l) };
    };

    const events: NativeSignalingStateEvent[] = [];
    const sub = addNativeSignalingStateListener((e) => events.push(e), fake.api);

    for (const l of listeners) l({ state: 'disconnected' });
    for (const l of listeners) l({ state: 'connected' });
    expect(events).toEqual([{ state: 'disconnected' }, { state: 'connected' }]);

    sub.remove();
    expect(listeners.size).toBe(0);
  });

  it('returns a no-op subscription when the native module predates the event', () => {
    const fake = createFakeNative();
    // createFakeNative does not implement addSignalingStateListener, matching
    // an older native binary.
    const sub = addNativeSignalingStateListener(() => {}, fake.api);
    expect(() => sub.remove()).not.toThrow();
  });
});

describe('nativeAuthFetch', () => {
  it('maps a JSON POST onto the native request and returns a Response', async () => {
    const fake = createFakeNative();
    (fake.api.request as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: '{"authenticated":true}',
    });

    const res = await nativeAuthFetch(
      'https://signal.example/attestation/response',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' },
      fake.api,
    );

    expect(fake.api.request).toHaveBeenCalledWith(
      'https://signal.example/attestation/response',
      'POST',
      { 'Content-Type': 'application/json' },
      '{"a":1}',
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ authenticated: true });
  });

  it('defaults to GET with no body and surfaces non-ok status', async () => {
    const fake = createFakeNative();
    (fake.api.request as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      body: '',
    });

    const res = await nativeAuthFetch('https://signal.example/auth/session', {}, fake.api);

    expect(fake.api.request).toHaveBeenCalledWith(
      'https://signal.example/auth/session',
      'GET',
      undefined,
      undefined,
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it('flattens a Headers instance into a plain string map', async () => {
    const fake = createFakeNative();
    (fake.api.request as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: '',
    });

    await nativeAuthFetch(
      'https://signal.example/assertion/response',
      { method: 'POST', headers: new Headers({ 'Content-Type': 'application/json' }), body: '{}' },
      fake.api,
    );

    const headersArg = (fake.api.request as jest.Mock).mock.calls[0][2];
    expect(headersArg).toMatchObject({ 'content-type': 'application/json' });
  });
});
