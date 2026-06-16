import { render, screen, fireEvent } from '@testing-library/react-native';
import { Text } from '@/components/ui/text';
import { Modal } from '@/components/Modal';

describe('Modal', () => {
  it('renders the title and children when visible', () => {
    render(
      <Modal visible title="Settings" onClose={() => {}}>
        <Text>Body content</Text>
      </Modal>,
    );
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(screen.getByText('Body content')).toBeTruthy();
  });

  it('calls onClose when the close button is pressed', () => {
    const onClose = jest.fn();
    render(
      <Modal visible title="Settings" onClose={onClose}>
        <Text>Body</Text>
      </Modal>,
    );
    fireEvent.press(screen.getByRole('button'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
