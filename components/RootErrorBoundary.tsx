import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import * as Sentry from '@sentry/react-native';
import * as React from 'react';
import { View } from 'react-native';

interface RootErrorBoundaryProps {
  children: React.ReactNode;
}

interface RootErrorBoundaryState {
  error: Error | null;
}

/**
 * Last-resort boundary around the whole navigation tree. Without one, a render
 * error anywhere is a *fatal* error in release builds: on iOS it becomes an
 * uncatchable native abort (`RCTFatal` → NSException rethrown through the
 * TurboModule interop), and when it happens during launch, expo-updates' error
 * recovery escalates it into a startup crash loop over the same persisted
 * state. Catching it here turns both into a recoverable screen instead.
 */
export class RootErrorBoundary extends React.Component<
  RootErrorBoundaryProps,
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // No-op unless Sentry.init() ran (internal testing builds only).
    Sentry.captureException(error, { contexts: { react: { componentStack: errorInfo.componentStack } } });
    console.error('RootErrorBoundary caught render error:', error, errorInfo.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <View className="flex-1 items-center justify-center gap-4 bg-background px-8">
          <Text className="text-lg font-semibold text-foreground">Something went wrong</Text>
          <Text className="text-center text-sm text-muted-foreground">
            The app hit an unexpected error while rendering. Your wallet keys are safe.
          </Text>
          <Text className="text-center text-xs text-muted-foreground" numberOfLines={4}>
            {this.state.error.message}
          </Text>
          <Button onPress={this.reset}>
            <Text>Try again</Text>
          </Button>
        </View>
      );
    }
    return this.props.children;
  }
}
