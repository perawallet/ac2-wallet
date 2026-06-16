import { render } from '@testing-library/react-native';
import * as React from 'react';

const mockQR = jest.fn((_props: Record<string, unknown>) => null);
jest.mock('react-native-qrcode-svg', () => (props: Record<string, unknown>) => {
  mockQR(props);
  return null;
});

import { QRCode } from '@/components/ui/QRCode';

describe('QRCode', () => {
  it('passes value and a default size to the underlying QR renderer', () => {
    render(<QRCode value="ADDR123" />);
    expect(mockQR).toHaveBeenCalledWith(expect.objectContaining({ value: 'ADDR123', size: 220 }));
  });

  it('respects a custom size', () => {
    render(<QRCode value="ADDR123" size={120} />);
    expect(mockQR).toHaveBeenCalledWith(expect.objectContaining({ size: 120 }));
  });
});
