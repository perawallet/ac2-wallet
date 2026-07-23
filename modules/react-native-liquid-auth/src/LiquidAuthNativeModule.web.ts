import { registerWebModule, NativeModule } from 'expo';

import {
  IceServer,
  LiquidAuthConnectOptions,
  LiquidAuthMessage,
  LiquidAuthNativeModuleEvents,
  LiquidAuthPeerType,
} from './LiquidAuthNative.types';

const UNSUPPORTED = 'LiquidAuthNative is not supported on web';

class LiquidAuthNativeModule extends NativeModule<LiquidAuthNativeModuleEvents> {
  generateRequestId(): string {
    throw new Error(UNSUPPORTED);
  }

  parseMessage(_value: string): LiquidAuthMessage {
    throw new Error(UNSUPPORTED);
  }

  async start(_url: string): Promise<void> {
    throw new Error(UNSUPPORTED);
  }

  async connect(
    _requestId: string,
    _type: LiquidAuthPeerType,
    _iceServers?: IceServer[],
    _options?: LiquidAuthConnectOptions
  ): Promise<void> {
    throw new Error(UNSUPPORTED);
  }

  async cancel(): Promise<void> {
    throw new Error(UNSUPPORTED);
  }

  send(_message: string): void {
    throw new Error(UNSUPPORTED);
  }

  sendToChannel(_channel: string, _message: string): void {
    throw new Error(UNSUPPORTED);
  }

  async disconnect(): Promise<void> {
    throw new Error(UNSUPPORTED);
  }
}

export default registerWebModule(LiquidAuthNativeModule, 'LiquidAuthNativeModule');
