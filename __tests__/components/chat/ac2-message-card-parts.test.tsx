import { render, screen, fireEvent } from '@testing-library/react-native';
import type { Ac2MessageEntry } from '@/stores/ac2Messages';
import { OutcomeRow, TechnicalDetails, ValueSummary } from '@/components/chat/Ac2MessageCard.parts';

const env = (type: string, body: Record<string, unknown> = {}) =>
  ({ type, body }) as unknown as Ac2MessageEntry['envelope'];

describe('ValueSummary', () => {
  it('shows the lead, amount, and truncated recipient', () => {
    render(<ValueSummary summary={{ lead: 'Sends', amount: '5 ALGO', to: 'ABCDEFGHIJKLMNOP' }} />);
    expect(screen.getByText('Sends')).toBeTruthy();
    expect(screen.getByText('5 ALGO')).toBeTruthy();
    expect(screen.getByText('To')).toBeTruthy();
  });
});

describe('OutcomeRow', () => {
  it('shows "Signed" for an approved signing request', () => {
    render(<OutcomeRow outcome="approved" kind="signing" />);
    expect(screen.getByText('Signed')).toBeTruthy();
  });

  it('shows "Identity granted" for an approved key request', () => {
    render(<OutcomeRow outcome="approved" kind="key" />);
    expect(screen.getByText('Identity granted')).toBeTruthy();
  });

  it('shows "Declined" for a rejected request', () => {
    render(<OutcomeRow outcome="rejected" kind="signing" />);
    expect(screen.getByText('Declined')).toBeTruthy();
  });
});

describe('TechnicalDetails', () => {
  it('is collapsed by default and expands on press', () => {
    render(
      <TechnicalDetails
        envelope={env('ac2/SigningRequest', { key_type: 'identity', display_hint: 'text' })}
        direction="inbound"
      />,
    );
    // Collapsed: the toggle is visible, the table is not.
    expect(screen.getByText('View technical details')).toBeTruthy();
    expect(screen.queryByText('Request type')).toBeNull();

    fireEvent.press(screen.getByText('View technical details'));

    expect(screen.getByText('Hide technical details')).toBeTruthy();
    expect(screen.getByText('Request type')).toBeTruthy();
    expect(screen.getByText('ac2/SigningRequest')).toBeTruthy();
    expect(screen.getByText('identity')).toBeTruthy();
    expect(screen.getByText('Ed25519 (raw)')).toBeTruthy();
    expect(screen.getByText('Plain text')).toBeTruthy();
    expect(screen.getByText('peer → this wallet')).toBeTruthy();
  });
});
