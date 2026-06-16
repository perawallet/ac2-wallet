export function formatMicroAmount(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  const result = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${result}` : result;
}

export function truncateAddress(address: string, lead = 6, trail = 4): string {
  if (address.length <= lead + trail) return address;
  return `${address.slice(0, lead)}…${address.slice(-trail)}`;
}
