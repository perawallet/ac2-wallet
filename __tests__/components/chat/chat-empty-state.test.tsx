import { render, screen, fireEvent } from '@testing-library/react-native';
import { ChatEmptyState } from '@/components/chat/ChatEmptyState';

describe('ChatEmptyState', () => {
  it('fires onScan from the CTA', () => {
    const onScan = jest.fn();
    render(<ChatEmptyState onScan={onScan} />);
    fireEvent.press(screen.getByLabelText('Scan QR code'));
    expect(onScan).toHaveBeenCalledTimes(1);
  });
});
