import { NativeModule, requireNativeModule } from 'expo';

import {
  IceServer,
  LiquidAuthConnectOptions,
  LiquidAuthMessage,
  LiquidAuthNativeModuleEvents,
  LiquidAuthPeerType,
} from './LiquidAuthNative.types';

declare class LiquidAuthNativeModule extends NativeModule<LiquidAuthNativeModuleEvents> {
  /**
   * Generate a random (time-based) request id.
   */
  generateRequestId(): string;

  /**
   * Parse a `liquid://<origin>/?requestId=<id>` URI (or JSON payload).
   */
  parseMessage(value: string): LiquidAuthMessage;

  /**
   * Start (and bind to) the background signaling service and connect the
   * signaling client to the given `origin`.
   */
  start(url: string): Promise<void>;

  /**
   * Connect to a remote peer by `requestId`.
   *
   * @param requestId the request id shared out of band (e.g. via a QR code)
   * @param type the *remote* peer type (`offer` or `answer`)
   * @param iceServers optional ICE server list (defaults to a public STUN server)
   * @param options optional connection options (e.g. named data channels)
   */
  connect(
    requestId: string,
    type: LiquidAuthPeerType,
    iceServers?: IceServer[],
    options?: LiquidAuthConnectOptions
  ): Promise<void>;

  /**
   * Abort an in-flight {@link connect} negotiation. The pending `connect`
   * promise rejects with an `E_ABORTED` error.
   */
  cancel(): Promise<void>;

  /**
   * Send a message over the primary (`liquid`) data channel.
   */
  send(message: string): void;

  /**
   * Send a message over a specific named data channel.
   */
  sendToChannel(channel: string, message: string): void;

  /**
   * Stop the signaling client and unbind/stop the background service.
   */
  disconnect(): Promise<void>;
}

// This call loads the native module object from the JSI.
export default requireNativeModule<LiquidAuthNativeModule>('LiquidAuthNative');
