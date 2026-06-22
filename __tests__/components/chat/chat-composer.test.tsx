import { render, screen, fireEvent } from '@testing-library/react-native';
import { ChatComposer } from '@/components/chat/ChatComposer';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

describe('ChatComposer', () => {
  it('sends trimmed text and clears the input', () => {
    const onSend = jest.fn();
    render(<ChatComposer onSend={onSend} />);
    const input = screen.getByPlaceholderText('Message');
    fireEvent.changeText(input, '  hello  ');
    fireEvent.press(screen.getByLabelText('Send message'));
    expect(onSend).toHaveBeenCalledWith('hello');
  });

  it('does not send empty text', () => {
    const onSend = jest.fn();
    render(<ChatComposer onSend={onSend} />);
    fireEvent.press(screen.getByLabelText('Send message'));
    expect(onSend).not.toHaveBeenCalled();
  });
});
