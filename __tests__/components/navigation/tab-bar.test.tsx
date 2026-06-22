import { render, screen, fireEvent } from '@testing-library/react-native';
import { TabBar } from '@/components/navigation/TabBar';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

function makeProps(navigate: jest.Mock, emit: jest.Mock) {
  const routes = ['chat', 'wallet', 'credentials', 'menu'].map((name) => ({ key: name, name }));
  return {
    state: { index: 0, routes },
    navigation: { navigate, emit: emit.mockReturnValue({ defaultPrevented: false }) },
    descriptors: {},
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
  } as any;
}

describe('TabBar', () => {
  it('renders all four tab labels', () => {
    render(<TabBar {...makeProps(jest.fn(), jest.fn())} />);
    ['Chat', 'Wallet', 'Credentials', 'Menu'].forEach((l) =>
      expect(screen.getByText(l)).toBeTruthy(),
    );
  });

  it('navigates to a tab when pressed', () => {
    const navigate = jest.fn();
    render(<TabBar {...makeProps(navigate, jest.fn())} />);
    fireEvent.press(screen.getByText('Wallet'));
    expect(navigate).toHaveBeenCalledWith('wallet');
  });
});
