import {
  isRegistrationBlockingNotice,
  normalizeNoticeFrame,
  parseStreamControlFrame,
  selectConnectionNoticeForRequest,
  STX,
  type ConnectionNotice,
} from '@/lib/ac2/stream';

const stx = String.fromCharCode(STX);

describe('parseStreamControlFrame', () => {
  it('returns null for a non-control-frame string', () => {
    expect(parseStreamControlFrame('hello')).toBeNull();
  });

  it('returns undefined for an STX-prefixed but malformed payload', () => {
    expect(parseStreamControlFrame(`${stx}not json`)).toBeUndefined();
  });

  it('parses a well-formed notice control frame', () => {
    const raw = `${stx}${JSON.stringify({ t: 'notice', code: 'controller_locked', text: 'hi' })}`;
    expect(parseStreamControlFrame(raw)).toEqual({
      t: 'notice',
      code: 'controller_locked',
      text: 'hi',
    });
  });
});

describe('normalizeNoticeFrame', () => {
  it('normalizes a complete notice frame', () => {
    expect(
      normalizeNoticeFrame({
        t: 'notice',
        code: 'controller_locked',
        level: 'warning',
        title: 'New wallet not registered',
        text: 'A new wallet is trying to connect.',
      }),
    ).toEqual({
      code: 'controller_locked',
      level: 'warning',
      title: 'New wallet not registered',
      text: 'A new wallet is trying to connect.',
    });
  });

  it('defaults level to warning and code to notice when omitted', () => {
    expect(normalizeNoticeFrame({ t: 'notice', text: 'heads up' })).toEqual({
      code: 'notice',
      level: 'warning',
      text: 'heads up',
    });
  });

  it('coerces an unknown level to warning', () => {
    const result = normalizeNoticeFrame({ t: 'notice', level: 'critical', text: 'x' });
    expect(result?.level).toBe('warning');
  });

  it('trims the text', () => {
    expect(normalizeNoticeFrame({ t: 'notice', text: '  spaced  ' })?.text).toBe('spaced');
  });

  it('returns null when text is missing or blank', () => {
    expect(normalizeNoticeFrame({ t: 'notice' })).toBeNull();
    expect(normalizeNoticeFrame({ t: 'notice', text: '   ' })).toBeNull();
  });

  it('returns null for a non-notice frame or non-object input', () => {
    expect(normalizeNoticeFrame({ t: 'finalize', text: 'x' })).toBeNull();
    expect(normalizeNoticeFrame(null)).toBeNull();
    expect(normalizeNoticeFrame('notice')).toBeNull();
  });

  it('omits an empty title', () => {
    expect(normalizeNoticeFrame({ t: 'notice', title: '', text: 'x' })).toEqual({
      code: 'notice',
      level: 'warning',
      text: 'x',
    });
  });
});

describe('selectConnectionNoticeForRequest', () => {
  const notice: ConnectionNotice = {
    code: 'controller_locked',
    level: 'warning',
    text: 'A new wallet is trying to connect.',
  };

  it('returns the notice when it belongs to the current connection', () => {
    expect(selectConnectionNoticeForRequest({ notice, requestId: 'req-1' }, 'req-1')).toBe(notice);
  });

  it('hides the notice when the connection (requestId) differs', () => {
    // Switching to a new connection (a new registration or a previously-paired
    // wallet) must not inherit the previous connection's banner.
    expect(selectConnectionNoticeForRequest({ notice, requestId: 'req-1' }, 'req-2')).toBeNull();
  });

  it('returns null when there is no stored notice', () => {
    expect(selectConnectionNoticeForRequest(null, 'req-1')).toBeNull();
  });
});

describe('isRegistrationBlockingNotice', () => {
  it('is true for the locked-out foreign-wallet notice', () => {
    expect(isRegistrationBlockingNotice('controller_locked')).toBe(true);
  });

  it('is true for the missing-identity notice', () => {
    expect(isRegistrationBlockingNotice('identity_missing')).toBe(true);
  });

  it('is false for an ordinary notice code', () => {
    expect(isRegistrationBlockingNotice('notice')).toBe(false);
  });

  it('is false for undefined/null', () => {
    expect(isRegistrationBlockingNotice(undefined)).toBe(false);
    expect(isRegistrationBlockingNotice(null)).toBe(false);
  });
});
