import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Alert, Platform } from 'react-native';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  NotificationFeedbackType: { Success: 'success' },
}));

import { RawContentViewer } from '@/components/ui/RawContentViewer';

const clipboardMock = Clipboard.setStringAsync as jest.MockedFunction<
  typeof Clipboard.setStringAsync
>;

const CONTENT = '{"hello":"world"}';

describe('RawContentViewer copy', () => {
  const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

  beforeEach(() => {
    jest.clearAllMocks();
    clipboardMock.mockResolvedValue(true);
  });

  afterEach(() => {
    Platform.OS = 'ios';
  });

  // Copying used to pop a blocking "Copied" alert on every platform; the button
  // now confirms in place, which also avoids doubling up on Android's own
  // system clipboard confirmation.
  it.each(['ios', 'android'] as const)(
    'confirms on the button without an alert on %s',
    async (os) => {
      Platform.OS = os;
      render(<RawContentViewer content={CONTENT} contentType="json" />);

      fireEvent.press(screen.getByLabelText('Copy json'));

      await waitFor(() => expect(clipboardMock).toHaveBeenCalledWith(CONTENT));
      expect(await screen.findByLabelText('json copied')).toBeTruthy();
      expect(alertSpy).not.toHaveBeenCalled();
    },
  );

  it('alerts when the clipboard rejects the content', async () => {
    clipboardMock.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    render(<RawContentViewer content={CONTENT} contentType="json" />);

    fireEvent.press(screen.getByLabelText('Copy json'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Copy failed', 'Could not copy to the clipboard.'),
    );
    expect(screen.queryByLabelText('json copied')).toBeNull();
  });
});
