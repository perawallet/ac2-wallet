import { render, screen } from '@testing-library/react-native';
import { MessageBubble } from '@/components/chat/MessageBubble';

describe('MessageBubble', () => {
  it('renders text for both sides', () => {
    const { rerender } = render(<MessageBubble text="hi" mine />);
    expect(screen.getByText('hi')).toBeTruthy();
    rerender(<MessageBubble text="yo" mine={false} />);
    expect(screen.getByText('yo')).toBeTruthy();
  });
});
