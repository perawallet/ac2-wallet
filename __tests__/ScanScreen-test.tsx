import { act, render } from '@testing-library/react-native';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import React from 'react';
import ScanScreen from '../app/scan';

// Mock expo-camera
jest.mock('expo-camera', () => {
  const React = require('react');
  return {
    CameraView: (props: any) => {
      // Store the callback so we can call it manually
      React.useEffect(() => {
        if (props.onBarcodeScanned) {
          (global as any).triggerBarcodeScanned = props.onBarcodeScanned;
        }
      }, [props.onBarcodeScanned]);
      return null;
    },
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
  };
});

// Mock expo-router
jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
  Stack: {
    Screen: () => null,
  },
}));

// Mock expo-linking
jest.mock('expo-linking', () => ({
  openURL: jest.fn(),
}));

// Mock useProvider hook
jest.mock('@/hooks/useProvider', () => ({
  useProvider: () => ({
    accounts: [{ address: 'ADDR123' }],
  }),
}));

// Mock MaterialIcons
jest.mock('@expo/vector-icons', () => ({
  MaterialIcons: 'MaterialIcons',
}));

// Mock Alert
import { Alert } from 'react-native';
jest.spyOn(Alert, 'alert').mockImplementation(() => {});

describe('<ScanScreen />', () => {
  const mockDismissTo = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useRouter as jest.Mock).mockReturnValue({
      dismissTo: mockDismissTo,
    });
  });

  it('handles fido: link (lowercase)', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({ type: 'qr', data: 'fido:test' });
    });

    expect(Linking.openURL).toHaveBeenCalledWith('fido:test');
    expect(mockDismissTo).toHaveBeenCalledWith('/chat');
  });

  it('handles FIDO: link (uppercase)', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({ type: 'qr', data: 'FIDO:test' });
    });

    expect(Linking.openURL).toHaveBeenCalledWith('FIDO:test');
    expect(mockDismissTo).toHaveBeenCalledWith('/chat');
  });

  it('handles liquid: link (lowercase)', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({
        type: 'qr',
        data: 'liquid:test.com?requestId=123',
      });
    });

    expect(mockDismissTo).toHaveBeenCalledWith('/chat');
  });

  it('handles LIQUID: link (uppercase)', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({
        type: 'qr',
        data: 'LIQUID:test.com?requestId=123',
      });
    });

    expect(mockDismissTo).toHaveBeenCalledWith('/chat');
  });

  it('handles LIQUID:// link (uppercase)', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({
        type: 'qr',
        data: 'LIQUID://test.com?requestId=456',
      });
    });

    expect(mockDismissTo).toHaveBeenCalledWith('/chat');
  });

  it('aborts on unsupported link', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({ type: 'qr', data: 'https://google.com' });
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      expect.stringContaining('Unsupported QR code'),
    );
    expect(mockDismissTo).toHaveBeenCalledWith('/chat');
  });

  it('dismisses to chat after scanning a Liquid Auth QR', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({
        type: 'qr',
        data: 'liquid:debug.liquidauth.com?requestId=019f1476-554e-73cb-82ee-ebe7ff16bfbf',
      });
    });

    expect(mockDismissTo).toHaveBeenCalledWith('/chat');
  });

  it('ignores duplicate barcode callbacks for the same scan session', async () => {
    render(<ScanScreen />);

    await act(async () => {
      await (global as any).triggerBarcodeScanned({
        type: 'qr',
        data: 'liquid:debug.liquidauth.com?requestId=019f1476-554e-73cb-82ee-ebe7ff16bfbf',
      });
      await (global as any).triggerBarcodeScanned({
        type: 'qr',
        data: 'liquid:debug.liquidauth.com?requestId=019f1476-554e-73cb-82ee-ebe7ff16bfbf',
      });
    });

    expect(mockDismissTo).toHaveBeenCalledTimes(1);
  });
});
