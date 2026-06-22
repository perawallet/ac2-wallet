import { render, screen, fireEvent } from '@testing-library/react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

describe('Button', () => {
  it('renders a button role with label text', () => {
    render(
      <Button>
        <Text>Press me</Text>
      </Button>,
    );
    expect(screen.getByRole('button')).toBeTruthy();
    expect(screen.getByText('Press me')).toBeTruthy();
  });

  it('calls onPress when pressed', () => {
    const onPress = jest.fn();
    render(
      <Button onPress={onPress}>
        <Text>Tap</Text>
      </Button>,
    );
    fireEvent.press(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not call onPress when disabled', () => {
    const onPress = jest.fn();
    render(
      <Button onPress={onPress} disabled>
        <Text>Disabled</Text>
      </Button>,
    );
    fireEvent.press(screen.getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('renders the secondary variant without crashing', () => {
    render(
      <Button variant="secondary">
        <Text>Secondary</Text>
      </Button>,
    );
    expect(screen.getByText('Secondary')).toBeTruthy();
  });
});
