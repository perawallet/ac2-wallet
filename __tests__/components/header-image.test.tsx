import { render, screen } from '@testing-library/react-native';
import { HeaderImage } from '@/components/HeaderImage';

describe('HeaderImage', () => {
  it('renders an image', () => {
    render(<HeaderImage />);
    expect(screen.getByTestId('header-image')).toBeTruthy();
  });
});
