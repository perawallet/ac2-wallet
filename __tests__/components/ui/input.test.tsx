import { render, screen } from '@testing-library/react-native';
import { Input } from '@/components/ui/input';

describe('Input', () => {
  it('renders with a placeholder', () => {
    render(<Input placeholder="Email" />);
    expect(screen.getByPlaceholderText('Email')).toBeTruthy();
  });
});
