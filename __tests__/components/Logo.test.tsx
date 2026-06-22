import { render, screen } from '@testing-library/react-native';
import Logo from '@/components/Logo';

describe('Logo', () => {
  it('renders the provider name initial as a fallback', () => {
    render(<Logo size={80} />);
    expect(screen.getByText(/^[A-Za-z]$/)).toBeTruthy();
  });
});
