/** Lowercase 32-byte txid. */
export const TXID_HEX_RE = /^[0-9a-f]{64}$/

export function normalizeTxid(raw: string | null | undefined): string | null {
  const id = String(raw ?? '').trim().toLowerCase()
  return TXID_HEX_RE.test(id) ? id : null
}
