import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/input';
import * as React from 'react';
import { Keyboard, View } from 'react-native';

interface ChatComposerProps {
  onSend: (text: string) => void;
  /** When false, the composer is read-only (e.g. while connecting). */
  enabled?: boolean;
  /** Overrides the input placeholder (e.g. "Connecting…"). */
  placeholder?: string;
}

function ChatComposer({ onSend, enabled = true, placeholder = 'Message' }: ChatComposerProps) {
  const [value, setValue] = React.useState('');
  const send = () => {
    const trimmed = value.trim();
    if (!trimmed || !enabled) return;
    onSend(trimmed);
    setValue('');
    Keyboard.dismiss();
  };
  return (
    <View
      className="flex-row items-center gap-2 border-t border-border bg-card p-2"
      style={{ paddingBottom: 8 }}
    >
      <Input
        className="flex-1"
        value={value}
        onChangeText={setValue}
        placeholder={placeholder}
        onSubmitEditing={send}
        returnKeyType="send"
        editable={enabled}
      />
      <IconButton
        name="send"
        tint="primary"
        accessibilityLabel="Send message"
        onPress={send}
        disabled={!value.trim() || !enabled}
      />
    </View>
  );
}

export { ChatComposer };
