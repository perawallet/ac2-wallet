import { MessageBubble } from '@/components/chat/MessageBubble';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Linking, Platform } from 'react-native';

describe('MessageBubble', () => {
  afterEach(() => {
    Platform.OS = 'ios';
    jest.restoreAllMocks();
  });

  it('renders text for both sides on iOS', () => {
    const { rerender } = render(<MessageBubble text="hi" mine />);
    expect(screen.getByDisplayValue('hi')).toBeTruthy();
    rerender(<MessageBubble text="yo" mine={false} />);
    expect(screen.getByDisplayValue('yo')).toBeTruthy();
  });

  // RN's Text `selectable` only ever exposes a "Copy" action for the whole
  // string on iOS, with no partial-selection handles — see
  // RCTParagraphComponentView.mm's `copy:` implementation, which always
  // copies `NSMakeRange(0, attributedText.length)`. A non-editable
  // multiline TextInput keeps UITextView's native `isSelectable` (which is
  // independent of `editable`), giving real drag-handle selection instead.
  it('uses a non-editable multiline TextInput for the message body on iOS', () => {
    render(<MessageBubble text="copy me" mine={false} />);
    const messageInput = screen.getByDisplayValue('copy me');
    expect(messageInput.props.editable).toBe(false);
    expect(messageInput.props.multiline).toBe(true);
  });

  // UITextView's native link/phone-number data detection is only honored
  // when `multiline` + `!editable` (already true above), and — unlike
  // `isSelectable` — doesn't disturb text selection. That makes it the only
  // way to get tappable links on iOS without regressing back to the
  // whole-string-only "Copy" behavior `selectable` Text gives.
  it('enables native link data detection on the iOS TextInput, even without a link', () => {
    render(<MessageBubble text="copy me" mine={false} />);
    const messageInput = screen.getByDisplayValue('copy me');
    expect(messageInput.props.dataDetectorTypes).toEqual(['link', 'phoneNumber']);
  });

  it('renders text for both sides on Android', () => {
    Platform.OS = 'android';
    const { rerender } = render(<MessageBubble text="hi" mine />);
    expect(screen.getByText('hi')).toBeTruthy();
    rerender(<MessageBubble text="yo" mine={false} />);
    expect(screen.getByText('yo')).toBeTruthy();
  });

  it('uses native selectable text for the message body on Android', () => {
    Platform.OS = 'android';
    render(<MessageBubble text="copy me" mine={false} />);
    const messageText = screen.getByText('copy me');
    expect(messageText.props.selectable).toBe(true);
  });

  it('renders a link as tappable text and opens it in the system browser on Android', () => {
    Platform.OS = 'android';
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    render(<MessageBubble text="see https://example.com now" mine={false} />);

    const link = screen.getByText('https://example.com');
    expect(link.props.accessibilityRole).toBe('link');

    fireEvent.press(link);
    expect(openURL).toHaveBeenCalledWith('https://example.com');
  });

  it('renders a mailto/tel link on Android without the scheme prefix, but opens the full URI', () => {
    Platform.OS = 'android';
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    render(<MessageBubble text="mailto:a@b.com or tel:+15551234567" mine={false} />);

    expect(screen.queryByText(/mailto:/)).toBeNull();
    expect(screen.queryByText(/tel:/)).toBeNull();

    fireEvent.press(screen.getByText('a@b.com'));
    expect(openURL).toHaveBeenCalledWith('mailto:a@b.com');

    fireEvent.press(screen.getByText('+15551234567'));
    expect(openURL).toHaveBeenCalledWith('tel:+15551234567');
  });

  it('keeps using the selectable TextInput on iOS when the message contains a link, relying on native data detection to make it tappable', () => {
    render(<MessageBubble text="see https://example.com now" mine={false} />);

    const messageInput = screen.getByDisplayValue('see https://example.com now');
    expect(messageInput.props.editable).toBe(false);
    expect(messageInput.props.multiline).toBe(true);
    expect(messageInput.props.dataDetectorTypes).toEqual(['link', 'phoneNumber']);
    expect(screen.queryByText('https://example.com')).toBeNull();
  });

  // The scheme prefix is stripped from the TextInput's underlying value
  // itself (not just hidden by styling), since it also drives the native
  // data detector — a bare email/number is what iOS actually recognizes as
  // a tappable mailto/tel link.
  it('strips the mailto/tel scheme prefix from the iOS TextInput value', () => {
    render(<MessageBubble text="mailto:a@b.com or tel:+15551234567" mine={false} />);

    expect(screen.getByDisplayValue('a@b.com or +15551234567')).toBeTruthy();
    expect(screen.queryByDisplayValue(/mailto:/)).toBeNull();
    expect(screen.queryByDisplayValue(/tel:/)).toBeNull();
  });
});
