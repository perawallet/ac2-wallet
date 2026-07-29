import {
  createRecoveryPhraseAccessToken,
  hasRecoveryPhraseAccess,
} from '@/lib/keystore/recovery-phrase-access';

describe('recovery phrase route access', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts only tokens created by a trusted in-app entry point', () => {
    const token = createRecoveryPhraseAccessToken();

    expect(hasRecoveryPhraseAccess(token)).toBe(true);
    expect(hasRecoveryPhraseAccess('forged-token')).toBe(false);
    expect(hasRecoveryPhraseAccess(undefined)).toBe(false);
  });

  it('expires route capabilities after a short window', () => {
    const now = 1_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const token = createRecoveryPhraseAccessToken();

    clock.mockReturnValue(now + 30_001);

    expect(hasRecoveryPhraseAccess(token)).toBe(false);
  });
});
