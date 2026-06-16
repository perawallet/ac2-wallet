import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/IconButton';

interface ChatComposerProps {
  onSend: (text: string) => void;
}

function ChatComposer({ onSend }: ChatComposerProps) {
  const [value, setValue] = React.useState('');
  const insets = useSafeAreaInsets();
  const send = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue('');
  };
  return (
    <View
      className="flex-row items-center gap-2 border-t border-border bg-card p-2"
      style={{ paddingBottom: Math.max(insets.bottom, 8) }}
    >
      <Input
        className="flex-1"
        value={value}
        onChangeText={setValue}
        placeholder="Message"
        onSubmitEditing={send}
        returnKeyType="send"
      />
      <IconButton
        name="send"
        tint="primary"
        accessibilityLabel="Send message"
        onPress={send}
        disabled={!value.trim()}
      />
    </View>
  );
}

export { ChatComposer };
