import { Ac2MessageCard } from '@/components/chat/Ac2MessageCard';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import { fireEvent, render, screen } from '@testing-library/react-native';

afterEach(() => {
  jest.restoreAllMocks();
});

const baseEntry = (envelope: Record<string, unknown>): Ac2MessageEntry =>
  ({
    id: 'e1',
    receivedAt: 1_700_000_000_000,
    origin: 'o',
    requestId: 'r',
    address: 'a',
    direction: 'inbound',
    envelope,
  }) as unknown as Ac2MessageEntry;

const noop = () => {};
const handlers = {
  approveSigning: noop,
  rejectSigning: noop,
  approveKey: noop,
  rejectKey: noop,
};

describe('Ac2MessageCard — non-fund signing request', () => {
  const entry = baseEntry({
    type: 'ac2/SigningRequest',
    id: 'req-1',
    body: { description: 'Confirm it is really you', key_type: 'identity', display_hint: 'text' },
  });

  it('shows the description and Decline/Approve actions, with no badge or warning', () => {
    render(<Ac2MessageCard entry={entry} isConnected actioned={false} {...handlers} />);
    expect(screen.getByText('Confirm it is really you')).toBeTruthy();
    expect(screen.getByText('Decline')).toBeTruthy();
    expect(screen.getByText('Approve')).toBeTruthy();
    // Non-fund-moving requests carry no safety badge (we can't attest safety)
    // and no transaction warning.
    expect(screen.queryByText('Safe · no funds involved')).toBeNull();
    expect(screen.queryByText(/about to sign a transaction/)).toBeNull();
    // No protocol noise on the face.
    expect(screen.queryByText('ac2/SigningRequest')).toBeNull();
  });

  it('replaces the buttons with the outcome once actioned', () => {
    render(<Ac2MessageCard entry={entry} isConnected actioned outcome="approved" {...handlers} />);
    expect(screen.getByText('Signed')).toBeTruthy();
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Decline')).toBeNull();
  });

  it('calls approveSigning when Approve is pressed', () => {
    const approveSigning = jest.fn();
    render(
      <Ac2MessageCard
        entry={entry}
        isConnected
        actioned={false}
        {...handlers}
        approveSigning={approveSigning}
      />,
    );
    fireEvent.press(screen.getByText('Approve'));
    expect(approveSigning).toHaveBeenCalledTimes(1);
  });
});

describe('Ac2MessageCard — fund-moving payment', () => {
  // amount 5 ALGO encoded? We rely on getTransactionSummary; mock it.
  it('shows a decoded transaction overview plus the transaction warning', () => {
    jest.spyOn(require('@/lib/algorand/transactions'), 'getTransactionSummary').mockReturnValue({
      type: require('@algorandfoundation/algokit-utils/transact').TransactionType.Payment,
      to: { toString: () => 'ABCDEFGHIJ' },
      amount: 5_000_000n,
      from: { toString: () => 'SENDER' },
    });
    const entry = baseEntry({
      type: 'ac2/SigningRequest',
      id: 'req-2',
      body: { description: 'Approve payment', sig_hint: 'transaction-algorand', payload: 'AA==' },
    });
    render(<Ac2MessageCard entry={entry} isConnected actioned={false} {...handlers} />);
    expect(screen.getByText('Single Algorand transaction')).toBeTruthy();
    expect(screen.getByText('Wallet signs')).toBeTruthy();
    expect(screen.getByText('ALGO payment')).toBeTruthy();
    expect(screen.getByText('5 ALGO')).toBeTruthy();
    expect(screen.getByText('From your wallet')).toBeTruthy();
    expect(screen.getByText('Requesting site')).toBeTruthy();
    // Legal-approved generic transaction warning, but not the smart-contract one.
    expect(screen.getByText(/about to sign a transaction/)).toBeTruthy();
    expect(screen.queryByText('Smart contract call')).toBeNull();
    expect(screen.queryByText('Safe · no funds involved')).toBeNull();
  });
});

describe('Ac2MessageCard — key request', () => {
  it('shows the operation text and Approve and Decline actions', () => {
    const entry = baseEntry({
      type: 'ac2/KeyRequest',
      id: 'req-3',
      body: { key_type: 'ed25519', purpose: ['sign'], for_operation: 'Sign on your behalf' },
    });
    render(<Ac2MessageCard entry={entry} isConnected actioned={false} {...handlers} />);
    expect(screen.getByText('Sign on your behalf')).toBeTruthy();
    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Decline')).toBeTruthy();
  });

  it('explains what the identity request is for', () => {
    const entry = baseEntry({
      type: 'ac2/KeyRequest',
      id: 'req-3b',
      body: { key_type: 'ed25519', purpose: ['sign', 'verify'], for_operation: 'Act for you' },
    });
    render(<Ac2MessageCard entry={entry} isConnected actioned={false} {...handlers} />);
    expect(screen.getByText('Agent identity request')).toBeTruthy();
    expect(screen.getByText(/Your wallet still approves all signing/)).toBeTruthy();
  });
});

describe('Ac2MessageCard — app-call warning banner', () => {
  it('shows the smart contract call warning for app-call transactions', () => {
    jest.spyOn(require('@/lib/algorand/transactions'), 'getTransactionSummary').mockReturnValue({
      type: require('@algorandfoundation/algokit-utils/transact').TransactionType.AppCall,
      appId: 123n,
      from: { toString: () => 'SENDER' },
      args: undefined,
    });
    const entry = baseEntry({
      type: 'ac2/SigningRequest',
      id: 'req-4',
      body: {
        description: 'Call a smart contract',
        sig_hint: 'transaction-algorand',
        payload: 'AA==',
      },
    });
    render(<Ac2MessageCard entry={entry} isConnected actioned={false} {...handlers} />);
    expect(screen.getAllByText(/Smart contract call/).length).toBeGreaterThan(0);
  });
});
