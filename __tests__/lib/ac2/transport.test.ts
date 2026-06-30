import {
  installSignalCandidateNormalizer,
  normalizeIceCandidateForReactNative,
} from '@/lib/ac2/transport';

describe('normalizeIceCandidateForReactNative', () => {
  it('strips aiortc-style SDP line prefixes from ICE candidates', () => {
    const candidate = {
      candidate: 'a=candidate:1 1 UDP 2116026367 10.0.0.64 58151 typ host',
      sdpMLineIndex: null,
      sdpMid: '0',
      usernameFragment: null,
    };

    expect(normalizeIceCandidateForReactNative(candidate)).toEqual({
      candidate: 'candidate:1 1 UDP 2116026367 10.0.0.64 58151 typ host',
      sdpMLineIndex: null,
      sdpMid: '0',
      usernameFragment: null,
    });
  });

  it('leaves browser-style ICE candidates unchanged', () => {
    const candidate = {
      candidate: 'candidate:2079853774 1 udp 2122194687 10.0.0.98 55266 typ host',
      sdpMLineIndex: 0,
      sdpMid: '0',
    };

    expect(normalizeIceCandidateForReactNative(candidate)).toBe(candidate);
  });
});

describe('installSignalCandidateNormalizer', () => {
  it('normalizes candidate events before invoking socket listeners', () => {
    const listeners = new Map<string, (...args: any[]) => unknown>();
    type MockSocket = {
      on: jest.Mock<MockSocket, [string, (...args: any[]) => unknown]>;
    };
    const socket: MockSocket = {
      on: jest.fn<MockSocket, [string, (...args: any[]) => unknown]>((event, listener) => {
        listeners.set(event, listener);
        return socket;
      }),
    };
    const signalClient = { socket } as any;
    const listener = jest.fn();

    installSignalCandidateNormalizer(signalClient);
    socket.on('answer-candidate', listener);
    listeners.get('answer-candidate')?.(
      {
        candidate: 'a=candidate:2 1 UDP 2114977535 10.0.0.64 58151 typ host',
        sdpMLineIndex: null,
        sdpMid: '0',
      },
      'extra-arg',
    );

    expect(listener).toHaveBeenCalledWith(
      {
        candidate: 'candidate:2 1 UDP 2114977535 10.0.0.64 58151 typ host',
        sdpMLineIndex: null,
        sdpMid: '0',
      },
      'extra-arg',
    );
  });
});
