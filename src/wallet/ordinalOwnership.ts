/**
 * Which 1-sat locking scripts this device can unlock with its root key.
 *
 * A transferred tip is a bare P2PKH, but an inscribed tip (origin output, or any
 * output that still carries the envelope) is P2PKH *plus* an
 * `OP_FALSE OP_IF "ord" … OP_ENDIF` branch — before or after the P2PKH.
 * The skipped branch does not change who can sign, so ownership is decided by
 * the P2PKH branch alone.
 */

import { P2PKH } from '@bsv/sdk'

/** `76a914<hash160>88ac` for an address, lowercase hex. */
export function p2pkhScriptHex(address: string): string {
  return new P2PKH().lock(address).toHex().toLowerCase()
}

/**
 * True when `scriptHex` pays `address` through a P2PKH branch, allowing an
 * inscription envelope on either side of it.
 */
export function scriptPaysAddress(
  scriptHex: string | undefined,
  address: string,
): boolean {
  if (!scriptHex) return false
  const script = scriptHex.trim().toLowerCase()
  if (!script) return false

  let expected: string
  try {
    expected = p2pkhScriptHex(address)
  } catch {
    return false
  }

  // Hex must match on a byte boundary, or inscription content could spoof a match.
  let at = script.indexOf(expected)
  while (at >= 0) {
    if (at % 2 === 0) return true
    at = script.indexOf(expected, at + 1)
  }
  return false
}
