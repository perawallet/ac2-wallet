import React from 'react';
import { View, Text, StyleSheet, TextInput, useWindowDimensions } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useColorScheme } from 'nativewind';
import { THEME } from '@/lib/theme';

interface SeedPhraseProps {
  recoveryPhrase: string[];
  showSeed: boolean;
  validateWords?: { [key: number]: string } | null;
  onInputChange?: (index: number, text: string) => void;
  primaryColor: string;
}

export default function SeedPhrase({
  recoveryPhrase,
  showSeed,
  validateWords = null,
  onInputChange,
  primaryColor,
}: SeedPhraseProps) {
  const { width } = useWindowDimensions();
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const overlayColor =
    colorScheme === 'dark' ? 'rgba(16, 16, 37, 0.86)' : 'rgba(247, 247, 255, 0.86)';

  const renderWord = (word: string, index: number) => {
    const isTestWord = validateWords !== null && index in validateWords;
    const shouldHideWord = !showSeed && !isTestWord && validateWords === null;

    // In test mode, we "remove" non-test words by not rendering them
    if (validateWords !== null && !isTestWord) {
      return null;
    }

    return (
      <Animated.View
        key={index}
        layout={LinearTransition.duration(300)}
        entering={FadeIn.duration(300)}
        exiting={FadeOut.duration(300)}
        style={[
          styles.wordBox,
          {
            width: (width - 64) / 3,
            backgroundColor: palette.card,
            borderColor: palette.border,
          },
          isTestWord && [styles.testWordBox, { width: (width - 56) / 2 }],
          isTestWord && { borderColor: primaryColor },
        ]}
      >
        <Text style={[styles.wordIndex, { color: palette.mutedForeground }]}>{index + 1}.</Text>
        {isTestWord ? (
          <TextInput
            style={[styles.wordInput, { color: palette.foreground }]}
            onChangeText={(text) => onInputChange?.(index, text)}
            value={validateWords[index] || ''}
            placeholder={`Word #${index + 1}`}
            placeholderTextColor={palette.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
          />
        ) : shouldHideWord ? (
          <View style={[styles.wordHidden, { backgroundColor: palette.border }]} />
        ) : (
          <Text style={[styles.wordText, { color: palette.foreground }]}>{word}</Text>
        )}
      </Animated.View>
    );
  };

  return (
    <View style={styles.container}>
      <Animated.View
        layout={LinearTransition.duration(300)}
        style={[styles.wordsGrid, { minHeight: (48 + 4) * 8 }]}
      >
        {recoveryPhrase && recoveryPhrase.length > 0
          ? recoveryPhrase.map((word, index) => renderWord(word, index))
          : // Placeholder grid during initial generation (if phrase not ready yet)
            [...Array(24)].map((_, index) => (
              <View
                key={index}
                style={[
                  styles.wordBox,
                  {
                    width: (width - 64) / 3,
                    backgroundColor: palette.card,
                    borderColor: palette.border,
                  },
                ]}
              >
                <Text style={[styles.wordIndex, { color: palette.mutedForeground }]}>
                  {index + 1}.
                </Text>
                <View style={[styles.wordHidden, { backgroundColor: palette.border }]} />
              </View>
            ))}

        {!showSeed && validateWords === null && (
          <Animated.View
            entering={FadeIn}
            exiting={FadeOut}
            style={[styles.lockOverlay, { backgroundColor: overlayColor }]}
          >
            <View style={[styles.lockCircle, { backgroundColor: primaryColor }]}>
              <MaterialIcons name="lock" size={32} color="#FFFFFF" />
            </View>
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 20,
  },
  wordsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
  },
  wordBox: {
    height: 48,
    borderRadius: 8,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    marginBottom: 4,
  },
  testWordBox: {
    height: 56,
    borderWidth: 2,
  },
  wordIndex: {
    fontSize: 10,
    width: 18,
  },
  wordText: {
    fontSize: 12,
    fontWeight: '600',
  },
  wordInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    padding: 0,
  },
  wordHidden: {
    flex: 1,
    height: 4,
    borderRadius: 2,
  },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
    zIndex: 10,
  },
  lockCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
    boxShadow: '0 2px 8px rgba(16, 16, 37, 0.22)',
  },
});
