import type { NativeDataChannel } from '@/lib/ac2/nativeChannel';
import {
  AC2_CONTROL_CHANNEL,
  createNativeAc2Transport,
  type LiquidAuthNativeApi,
  nativeAuthFetch,
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

  const sub = (set: Set<(e: any) => void>, l: (e: any) => void) => {
    set.add(l);
    return { remove: () => set.delete(l) };
  };
  const emit = (set: Set<(e: any) => void>, e: any) => {
    for (const l of [...set]) l(e);
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
    setActive: jest.fn(() => {}),
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

    // Side channels are surfaced before negotiation completes.
    expect(sideChannels.map((c) => c.label).sort()).toEqual(['ac2-heartbeat', 'ac2-stream']);

    fake.emitState(AC2_CONTROL_CHANNEL, 'OPEN');
    fake.resolveConnect();
    const setup = await promise;

    expect(setup.datachannel.label).toBe(AC2_CONTROL_CHANNEL);
    expect(setup.datachannel.readyState).toBe('open');
    expect(onPeerConnection).toHaveBeenCalledWith(setup.peerConnection);
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
