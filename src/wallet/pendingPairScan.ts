/**
 * One-shot pending device-pair QR from Dashboard Scan → Use on another device.
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
