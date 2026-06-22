import { formatMicroAmount, truncateAddress } from '@/utils/format';

describe('formatMicroAmount', () => {
  it('formats zero', () => {
    expect(formatMicroAmount(0n, 6)).toBe('0.00');
  });
  it('formats a whole number', () => {
    expect(formatMicroAmount(12_000_000n, 6)).toBe('12.00');
  });
  it('formats a fractional amount, keeping at least two decimals', () => {
    expect(formatMicroAmount(12_500_000n, 6)).toBe('12.50');
    expect(formatMicroAmount(1_230_000n, 6)).toBe('1.23');
  });
  it('keeps sub-unit precision', () => {
    expect(formatMicroAmount(1n, 6)).toBe('0.000001');
  });
});

describe('truncateAddress', () => {
  it('truncates a long address with an ellipsis', () => {
    const addr = 'A'.repeat(58);
    expect(truncateAddress(addr)).toBe('AAAAAA…AAAA');
  });
  it('returns short strings unchanged', () => {
    expect(truncateAddress('ABCDEF')).toBe('ABCDEF');
  });
});
