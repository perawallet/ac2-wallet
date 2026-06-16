import { render, screen, fireEvent } from '@testing-library/react-native';
import { IconButton } from '@/components/ui/IconButton';

describe('IconButton', () => {
  it('fires onPress and exposes its accessibility label', () => {
    const onPress = jest.fn();
    render(<IconButton name="menu" accessibilityLabel="Open menu" onPress={onPress} />);
    const btn = screen.getByLabelText('Open menu');
    fireEvent.press(btn);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
