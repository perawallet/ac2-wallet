import { MessageBubble } from '@/components/chat/MessageBubble';
import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

describe('MessageBubble', () => {
  afterEach(() => {
    Platform.OS = 'ios';
  });

  it('renders text for both sides on iOS', () => {
    const { rerender } = render(<MessageBubble text="hi" mine />);
    expect(screen.getByDisplayValue('hi')).toBeTruthy();
    rerender(<MessageBubble text="yo" mine={false} />);
    expect(screen.getByDisplayValue('yo')).toBeTruthy();
  });

  // RN's Text `selectable` only ever exposes a "Copy" action for the whole
  // string on iOS, with no partial-selection handles — see
  // RCTParagraphComponentView.mm's `copy:` implementation, which always
  // copies `NSMakeRange(0, attributedText.length)`. A non-editable
  // multiline TextInput keeps UITextView's native `isSelectable` (which is
  // independent of `editable`), giving real drag-handle selection instead.
  it('uses a non-editable multiline TextInput for the message body on iOS', () => {
    render(<MessageBubble text="copy me" mine={false} />);
    const messageInput = screen.getByDisplayValue('copy me');
    expect(messageInput.props.editable).toBe(false);
    expect(messageInput.props.multiline).toBe(true);
  });

  it('renders text for both sides on Android', () => {
    Platform.OS = 'android';
    const { rerender } = render(<MessageBubble text="hi" mine />);
    expect(screen.getByText('hi')).toBeTruthy();
    rerender(<MessageBubble text="yo" mine={false} />);
    expect(screen.getByText('yo')).toBeTruthy();
  });

  it('uses native selectable text for the message body on Android', () => {
    Platform.OS = 'android';
    render(<MessageBubble text="copy me" mine={false} />);
    const messageText = screen.getByText('copy me');
    expect(messageText.props.selectable).toBe(true);
  });
});
