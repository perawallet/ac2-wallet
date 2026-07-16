const ACCESS_TOKEN_TTL_MS = 30_000;
const activeTokens = new Map<string, number>();

function pruneExpiredTokens(now: number) {
  for (const [token, expiresAt] of activeTokens) {
    if (expiresAt <= now) activeTokens.delete(token);
  }
}

/**
 * Creates a short-lived capability for the recovery-phrase route.
 *
 * Only trusted in-app entry points call this function. A raw deep link cannot
 * manufacture a valid token, so the route fails closed unless navigation came
 * from the backup banner or a successfully authenticated settings action.
 */
export function createRecoveryPhraseAccessToken(): string {
  const now = Date.now();
  pruneExpiredTokens(now);

  const token = globalThis.crypto.randomUUID();
  activeTokens.set(token, now + ACCESS_TOKEN_TTL_MS);
  return token;
}

export function hasRecoveryPhraseAccess(token: string | string[] | undefined): boolean {
  if (typeof token !== 'string') return false;

  const now = Date.now();
  pruneExpiredTokens(now);
  return (activeTokens.get(token) ?? 0) > now;
}
