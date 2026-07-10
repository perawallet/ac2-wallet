import * as React from 'react';
import { Image } from 'expo-image';
import { View, useWindowDimensions } from 'react-native';

const onboardingLock = require('../assets/images/onboarding-lock.png');

function HeaderImage() {
  const { width, height } = useWindowDimensions();
  const referenceHeight = width * (16 / 9);
  const tallScreenSurplus = Math.max(0, height - referenceHeight);
  const verticalOffset = width * 0.035 + tallScreenSurplus * 0.27;
  const visibleHeight = Math.min(width * 1.075, height * 0.615) + verticalOffset;
  const imageSize = Math.min(width * 0.9, height * 0.54);
  const topPadding = Math.min(width * 0.128, height * 0.072) + verticalOffset;

  return (
    <View
      style={{
        alignItems: 'center',
        height: visibleHeight,
        paddingTop: topPadding,
        width: '100%',
      }}
    >
      <Image
        source={onboardingLock}
        contentFit="contain"
        accessibilityIgnoresInvertColors
        accessibilityLabel="Translucent AC2 Wallet lock"
        testID="header-image"
        style={{ width: imageSize, height: imageSize }}
      />
    </View>
  );
}

export { HeaderImage };
