import * as React from 'react';
import { Image } from 'expo-image';
import { View, useWindowDimensions } from 'react-native';

const onboardingLock = require('../assets/images/onboarding-lock.png');

function HeaderImage() {
  const { width, height } = useWindowDimensions();
  const visibleHeight = height * 0.615;
  const imageSize = Math.min(width * 0.9, height * 0.54);

  return (
    <View
      style={{
        alignItems: 'center',
        height: visibleHeight,
        paddingTop: height * 0.072,
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
