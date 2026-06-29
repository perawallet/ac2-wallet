import { render, screen } from '@testing-library/react-native';
import { ChatTimeline, type TimelineEntry } from '@/components/chat/ChatTimeline';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

const requestEntry: Ac2MessageEntry = {
  id: 'e1',
  receivedAt: 1_700_000_000_000,
  origin: 'o',
  requestId: 'r',
  address: 'a',
  direction: 'inbound',
  envelope: {
    type: 'ac2/SigningRequest',
    id: 'req-1',
    body: { description: 'Prove ownership', key_type: 'identity' },
  },
} as unknown as Ac2MessageEntry;

const timeline: TimelineEntry[] = [
  { kind: 'ac2', id: 'a-e1', timestamp: requestEntry.receivedAt, data: requestEntry },
];

const handlers = {
  approveSigning: () => {},
  rejectSigning: () => {},
  approveKey: () => {},
  rejectKey: () => {},
};

describe('ChatTimeline outcome wiring', () => {
  it('passes the outcome through so the card shows "Signed"', () => {
    render(
      <ChatTimeline
        timeline={timeline}
        isConnected
        actionedRequestIds={new Set(['req-1'])}
        outcomeByThid={new Map([['req-1', 'approved']])}
        {...handlers}
      />,
    );
    expect(screen.getByText('Signed')).toBeTruthy();
    expect(screen.queryByText('Approve')).toBeNull();
  });

  it('shows the action buttons when there is no outcome', () => {
    render(
      <ChatTimeline
        timeline={timeline}
        isConnected
        actionedRequestIds={new Set()}
        outcomeByThid={new Map()}
        {...handlers}
      />,
    );
    expect(screen.getByText('Approve')).toBeTruthy();
  });
});
