import React from 'react';
import { View, Image, ViewStyle } from 'react-native';
import Constants from 'expo-constants';
import { Text } from '@/components/ui/text';

interface LogoProps {
  size?: number;
  style?: ViewStyle;
}

export default function Logo({ size = 60, style }: LogoProps) {
  const config = Constants.expoConfig?.extra?.provider || { name: 'Rocca' };
  const { name, logo } = config;

  const borderRadius = size / 2;
  const fontSize = size * 0.5;

  if (logo) {
    return (
      <View className="items-center justify-center" style={[{ width: size, height: size }, style]}>
        <Image
          source={typeof logo === 'string' ? { uri: logo } : logo}
          style={{ width: size, height: size, borderRadius }}
          resizeMode="contain"
        />
      </View>
    );
  }

  return (
    <View className="items-center justify-center" style={[{ width: size, height: size }, style]}>
      <View
        className="items-center justify-center border-2 border-primary bg-secondary"
        style={{ width: size, height: size, borderRadius }}
      >
        <Text className="font-bold text-primary" style={{ fontSize }}>
          {name ? name.charAt(0) : 'R'}
        </Text>
      </View>
    </View>
  );
}
