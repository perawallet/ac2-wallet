import fs from 'node:fs';
import path from 'node:path';

describe('LiquidAuthNative iOS autolinking', () => {
  const moduleRoot = path.join(__dirname, '..', 'modules', 'react-native-liquid-auth');

  it('declares the Apple module for Expo autolinking', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(moduleRoot, 'expo-module.config.json'), 'utf8'),
    );

    expect(config.platforms).toContain('apple');
    expect(config.apple.modules).toContain('LiquidAuthNativeModule');
  });

  it('uses an app-compatible deployment target and the existing WebRTC provider', () => {
    const podspec = fs.readFileSync(
      path.join(moduleRoot, 'ios', 'LiquidAuthNative.podspec'),
      'utf8',
    );

    expect(podspec).toContain(":ios => '15.1'");
    expect(podspec).toContain("s.dependency 'JitsiWebRTC'");
    expect(podspec).not.toContain("s.dependency 'WebRTC-lib'");
  });

  it('exports every iOS method required by the native transport', () => {
    const moduleSource = fs.readFileSync(
      path.join(moduleRoot, 'ios', 'LiquidAuthNativeModule.swift'),
      'utf8',
    );

    for (const method of [
      'generateRequestId',
      'parseMessage',
      'start',
      'connect',
      'cancel',
      'getConnectionState',
      'attach',
      'setActive',
      'flushQueue',
      'send',
      'sendToChannel',
      'disconnect',
      'request',
    ]) {
      expect(moduleSource).toMatch(new RegExp(`(?:Async)?Function\\("${method}"\\)`));
    }
  });
});
