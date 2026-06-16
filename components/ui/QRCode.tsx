import * as React from 'react';
import { View } from 'react-native';
import QRCodeSvg from 'react-native-qrcode-svg';

interface QRCodeProps {
  value: string;
  size?: number;
}

function QRCode({ value, size = 220 }: QRCodeProps) {
  return (
    <View className="items-center justify-center rounded-2xl bg-white p-4">
      <QRCodeSvg value={value} size={size} />
    </View>
  );
}

export { QRCode };
