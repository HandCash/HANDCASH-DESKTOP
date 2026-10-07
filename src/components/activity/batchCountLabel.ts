/**
 * The batch count as it fits the icon corner: exact up to 999, then thousands
 * with a `k` — one decimal below 10k. Always rounded down, so the corner never
 * claims more items than the batch holds.
 */
export function batchCountLabel(count: number): string {
  const n = Math.max(0, Math.floor(count))
  if (n < 1_000) return String(n)
  if (n < 10_000) {
    const tenths = Math.floor(n / 100)
    return tenths % 10 === 0 ? `${tenths / 10}k` : `${(tenths / 10).toFixed(1)}k`
  }
  return `${Math.floor(n / 1_000)}k`
}
