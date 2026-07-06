import { THEME } from '@/lib/theme';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CopilotProvider, type TooltipProps, useCopilot } from 'react-native-copilot';

function CopilotTooltip({ labels }: TooltipProps) {
  const { isFirstStep, isLastStep, currentStep, goToNext, goToPrev, stop } = useCopilot();
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;

  return (
    <View>
      <Text style={[styles.text, { color: palette.foreground }]}>{currentStep?.text}</Text>
      <View style={styles.bottomBar}>
        {!isLastStep ? (
          <TouchableOpacity onPress={stop} style={styles.button}>
            <Text style={[styles.buttonText, { color: palette.mutedForeground }]}>
              {labels.skip}
            </Text>
          </TouchableOpacity>
        ) : null}
        {!isFirstStep ? (
          <TouchableOpacity onPress={goToPrev} style={styles.button}>
            <Text style={[styles.buttonText, { color: palette.primary }]}>{labels.previous}</Text>
          </TouchableOpacity>
        ) : null}
        {!isLastStep ? (
          <TouchableOpacity onPress={goToNext} style={styles.button}>
            <Text style={[styles.buttonText, { color: palette.primary }]}>{labels.next}</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={stop} style={styles.button}>
            <Text style={[styles.buttonText, { color: palette.primary }]}>{labels.finish}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function CopilotStepNumber() {
  const { currentStepNumber } = useCopilot();
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;

  return (
    <View style={[styles.stepNumber, { backgroundColor: palette.primary }]}>
      <Text style={styles.stepNumberText}>{currentStepNumber}</Text>
    </View>
  );
}

export function ThemedCopilotProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useColorScheme();
  const palette = colorScheme === 'dark' ? THEME.dark : THEME.light;

  return (
    <CopilotProvider
      overlay="svg"
      animated
      // Android defaults to treating the status bar as hidden and subtracting
      // `StatusBar.currentHeight`, which shifts the spotlight/tooltip upward.
      androidStatusBarVisible
      tooltipComponent={CopilotTooltip}
      stepNumberComponent={CopilotStepNumber}
      tooltipStyle={{
        backgroundColor: palette.card,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: palette.border,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.12,
        shadowRadius: 8,
        elevation: 8,
        paddingTop: 0,
        paddingLeft: 0,
        paddingRight: 0,
      }}
      arrowColor={palette.card}
      backdropColor="rgba(0,0,0,0.5)"
    >
      {children}
    </CopilotProvider>
  );
}

const styles = StyleSheet.create({
  text: {
    fontSize: 15,
    lineHeight: 22,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  bottomBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 8,
    paddingBottom: 8,
  },
  button: {
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumberText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
