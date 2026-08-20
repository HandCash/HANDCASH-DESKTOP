/**
 * One-shot pending device code QR from Dashboard Scan → Device backup.
 */
let pendingPairRaw: string | null = null

export function setPendingPairScan(raw: string): void {
  pendingPairRaw = raw.trim() || null
}

export function takePendingPairScan(): string | null {
  const value = pendingPairRaw
  pendingPairRaw = null
  return value
}

export function peekPendingPairScan(): string | null {
  return pendingPairRaw
}
