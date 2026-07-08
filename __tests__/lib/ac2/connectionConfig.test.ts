import { computeReconnectDelay } from '@/lib/ac2/connectionConfig';

describe('computeReconnectDelay', () => {
  // Deterministic: random() = 0.5 -> jitter factor (0.5*2 - 1) = 0 -> no jitter.
  const noJitter = () => 0.5;

  it('grows exponentially from the base delay', () => {
    expect(computeReconnectDelay(1, noJitter)).toBe(3000);
    expect(computeReconnectDelay(2, noJitter)).toBe(6000);
    expect(computeReconnectDelay(3, noJitter)).toBe(12000);
  });

  it('caps at the maximum delay', () => {
    // 3000 * 2^4 = 48000, capped to 20000.
    expect(computeReconnectDelay(5, noJitter)).toBe(20000);
    expect(computeReconnectDelay(10, noJitter)).toBe(20000);
  });

  it('applies bounded jitter around the backoff', () => {
    const maxNegative = computeReconnectDelay(1, () => 0); // factor -1 -> -750
    const maxPositive = computeReconnectDelay(1, () => 1); // factor +1 -> +750
    expect(maxNegative).toBe(2250);
    expect(maxPositive).toBe(3750);
  });

  it('never returns a negative delay', () => {
    // Attempt 1 base is 3000; jitter can only shift by +/-750, so this is safe,
    // but guard the contract explicitly.
    expect(computeReconnectDelay(1, () => 0)).toBeGreaterThanOrEqual(0);
  });
});
