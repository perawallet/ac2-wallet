import { render, screen } from '@testing-library/react-native';
import { PlaceholderScreen } from '@/components/PlaceholderScreen';

describe('PlaceholderScreen', () => {
  it('renders the title and subtitle', () => {
    render(
      <PlaceholderScreen icon="account-balance-wallet" title="Wallet" subtitle="Coming soon" />,
    );
    expect(screen.getByText('Wallet')).toBeTruthy();
    expect(screen.getByText('Coming soon')).toBeTruthy();
  });
});
