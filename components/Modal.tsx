import React from 'react';
import {
  View,
  Modal as RNModal,
  Pressable,
  ScrollView,
  ModalProps as RNModalProps,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/theme';

interface ModalProps extends RNModalProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

export const Modal = ({ visible, onClose, title, children, ...props }: ModalProps) => {
  const { colorScheme } = useColorScheme();
  const iconColor =
    colorScheme === 'dark' ? THEME.dark.mutedForeground : THEME.light.mutedForeground;

  return (
    <RNModal
      animationType="slide"
      transparent
      visible={visible}
      onRequestClose={onClose}
      {...props}
    >
      <View className="flex-1 items-center justify-center bg-black/50 p-5">
        <View className="max-h-[80%] w-full rounded-3xl bg-card shadow-lg">
          <View className="flex-row items-center justify-between border-b border-border p-5">
            {title ? (
              <Text className="text-lg font-bold text-card-foreground">{title}</Text>
            ) : (
              <View />
            )}
            <Pressable onPress={onClose} accessibilityRole="button" className="p-1">
              <MaterialIcons name="close" size={24} color={iconColor} />
            </Pressable>
          </View>
          <ScrollView className="max-h-[400px] p-5">{children}</ScrollView>
        </View>
      </View>
    </RNModal>
  );
};

export default Modal;
