import { MessageBubble } from '@/components/chat/MessageBubble';
import { render, screen } from '@testing-library/react-native';

describe('MessageBubble', () => {
  it('renders text for both sides', () => {
    const { rerender } = render(<MessageBubble text="hi" mine />);
    expect(screen.getByText('hi')).toBeTruthy();
    rerender(<MessageBubble text="yo" mine={false} />);
    expect(screen.getByText('yo')).toBeTruthy();
  });

  it('uses native selectable text for message body', () => {
    render(<MessageBubble text="copy me" mine={false} />);
    const messageText = screen.getByText('copy me');
    expect(messageText.props.selectable).toBe(true);
  });
});
