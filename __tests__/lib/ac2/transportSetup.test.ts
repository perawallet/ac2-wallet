import { buildSignalClientOptions, createFetchWithTimeout } from '@/lib/ac2/transportSetup';
import { XHR as MockXHR } from 'engine.io-client';
import { NativeModules, Platform } from 'react-native';

jest.mock('engine.io-client', () => ({ XHR: class MockXHR {} }));

// Return concrete literals so the mock objects exist at import time (jest.mock
// factories run before module-scope `const`s initialize); tests then mutate the
// imported `Platform`/`NativeModules` in place to drive the branches.
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  NativeModules: {},
}));

const mockPlatform = Platform as { OS: string };
const mockNativeModules = NativeModules as { CookieModule?: { getCookie: jest.Mock } };

describe('createFetchWithTimeout', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('resolves with the fetch response and clears the timer + run listener', async () => {
    const response = { ok: true } as Response;
    (global.fetch as jest.Mock).mockResolvedValue(response);
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const run = new AbortController();
    const removeListenerSpy = jest.spyOn(run.signal, 'removeEventListener');

    const fetchWithTimeout = createFetchWithTimeout(run.signal, 1000);
    await expect(fetchWithTimeout('https://example.com')).resolves.toBe(response);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('passes a per-request abort signal to fetch', () => {
    jest.useFakeTimers();
    let capturedInit: RequestInit | undefined;
    (global.fetch as jest.Mock).mockImplementation((_url, init) => {
      capturedInit = init;
      return new Promise<Response>(() => {});
    });
    const run = new AbortController();

    createFetchWithTimeout(run.signal, 1000)('https://example.com');

    expect(global.fetch).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect((capturedInit!.signal as AbortSignal).aborted).toBe(false);
  });

  it('aborts the request once the default timeout elapses', () => {
    jest.useFakeTimers();
    let capturedInit: RequestInit | undefined;
    (global.fetch as jest.Mock).mockImplementation((_url, init) => {
      capturedInit = init;
      return new Promise<Response>(() => {});
    });
    const run = new AbortController();

    createFetchWithTimeout(run.signal, 1000)('https://example.com');
    const signal = capturedInit?.signal as AbortSignal;

    expect(signal.aborted).toBe(false);
    jest.advanceTimersByTime(999);
    expect(signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
  });

  it('honors a per-call timeout override', () => {
    jest.useFakeTimers();
    let capturedInit: RequestInit | undefined;
    (global.fetch as jest.Mock).mockImplementation((_url, init) => {
      capturedInit = init;
      return new Promise<Response>(() => {});
    });
    const run = new AbortController();

    createFetchWithTimeout(run.signal, 10000)('https://example.com', {}, 50);
    const signal = capturedInit?.signal as AbortSignal;

    jest.advanceTimersByTime(50);
    expect(signal.aborted).toBe(true);
  });

  it('aborts immediately when the run signal is already aborted', () => {
    jest.useFakeTimers();
    let capturedInit: RequestInit | undefined;
    (global.fetch as jest.Mock).mockImplementation((_url, init) => {
      capturedInit = init;
      return new Promise<Response>(() => {});
    });
    const run = new AbortController();
    run.abort();

    createFetchWithTimeout(run.signal, 1000)('https://example.com');

    expect((capturedInit!.signal as AbortSignal).aborted).toBe(true);
  });

  it('aborts the in-flight request when the run signal aborts mid-flight', () => {
    jest.useFakeTimers();
    let capturedInit: RequestInit | undefined;
    (global.fetch as jest.Mock).mockImplementation((_url, init) => {
      capturedInit = init;
      return new Promise<Response>(() => {});
    });
    const run = new AbortController();

    createFetchWithTimeout(run.signal, 10000)('https://example.com');
    const signal = capturedInit?.signal as AbortSignal;

    expect(signal.aborted).toBe(false);
    run.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe('buildSignalClientOptions', () => {
  afterEach(() => {
    mockPlatform.OS = 'ios';
    delete mockNativeModules.CookieModule;
  });

  it('always includes the base connection options', async () => {
    mockPlatform.OS = 'ios';

    const options = await buildSignalClientOptions('https://example.com');

    expect(options.autoConnect).toBe(true);
    expect(options.withCredentials).toBe(true);
    expect(options.transportOptions).toEqual({});
  });

  it('uses the engine.io XHR transport on iOS without fetching a cookie', async () => {
    mockPlatform.OS = 'ios';
    mockNativeModules.CookieModule = { getCookie: jest.fn() };

    const options = await buildSignalClientOptions('https://example.com');

    expect(options.transports).toEqual([MockXHR]);
    expect(options.extraHeaders).toBeUndefined();
    expect(mockNativeModules.CookieModule.getCookie).not.toHaveBeenCalled();
  });

  it('forwards the persisted cookie over long-polling on Android', async () => {
    mockPlatform.OS = 'android';
    mockNativeModules.CookieModule = { getCookie: jest.fn().mockResolvedValue('sid=abc') };

    const options = await buildSignalClientOptions('https://example.com');

    expect(mockNativeModules.CookieModule.getCookie).toHaveBeenCalledWith('https://example.com');
    expect(options.extraHeaders).toEqual({ Cookie: 'sid=abc' });
    expect(options.transports).toEqual(['polling']);
    expect(options.transportOptions).toEqual({
      polling: { extraHeaders: { Cookie: 'sid=abc' } },
    });
  });

  it('leaves transport defaults untouched when Android has no cookie', async () => {
    mockPlatform.OS = 'android';
    mockNativeModules.CookieModule = { getCookie: jest.fn().mockResolvedValue(null) };

    const options = await buildSignalClientOptions('https://example.com');

    expect(options.transports).toBeUndefined();
    expect(options.extraHeaders).toBeUndefined();
    expect(options.transportOptions).toEqual({});
  });

  it('leaves transport defaults untouched when the CookieModule is absent', async () => {
    mockPlatform.OS = 'android';

    const options = await buildSignalClientOptions('https://example.com');

    expect(options.transports).toBeUndefined();
    expect(options.extraHeaders).toBeUndefined();
  });
});
