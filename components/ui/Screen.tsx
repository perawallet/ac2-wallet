import * as React from 'react';
import { View } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { cn } from '@/lib/utils';

interface ScreenProps {
  children: React.ReactNode;
  className?: string;
  edges?: Edge[];
}

function Screen({ children, className, edges = ['top', 'bottom'] }: ScreenProps) {
  return (
    <SafeAreaView edges={edges} className="flex-1 bg-background">
      <View className={cn('flex-1', className)}>{children}</View>
    </SafeAreaView>
  );
}

export { Screen };
