import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Image, useWindowDimensions } from 'react-native';

const LIGHT = require('../assets/images/header-light.png');
const DARK = require('../assets/images/header-dark.png');

function HeaderImage() {
  const { colorScheme } = useColorScheme();
  const { height } = useWindowDimensions();

  // Full-bleed banner: spans the full screen width and ~half its height.
  // `cover` preserves the aspect ratio and crops the sides rather than
  // letterboxing, so it never shows padding around the edges.
  return (
    <Image
      source={colorScheme === 'dark' ? DARK : LIGHT}
      resizeMode="cover"
      accessibilityIgnoresInvertColors
      testID="header-image"
      style={{ width: '100%', height: height / 2 }}
    />
  );
}

export { HeaderImage };
