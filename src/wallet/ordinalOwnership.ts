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

/** Opcode values used by the 1Sat `ord` envelope. */
const OP_FALSE = 0x00
const OP_IF = 0x63
const OP_ENDIF = 0x68

function hexBytes(hex: string): number[] | null {
  const normalized = hex.trim()
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) {
    return null
  }
  const bytes: number[] = []
  for (let i = 0; i < normalized.length; i += 2) {
    bytes.push(Number.parseInt(normalized.slice(i, i + 2), 16))
  }
  return bytes
}

/**
 * True when a locking script contains a structurally complete first 1Sat
 * inscription envelope: `OP_FALSE OP_IF <"ord"> ... OP_ENDIF`.
 *
 * This intentionally does not interpret inscription content. BRC-150 only
 * needs to prove that the claimed origin is the first output in the supplied
 * sat path carrying a valid `ord` envelope.
 */
export function hasOrdEnvelope(scriptHex: string | undefined): boolean {
  if (!scriptHex) return false
  const bytes = hexBytes(scriptHex)
  if (!bytes) return false

  for (let i = 0; i + 5 < bytes.length; i++) {
    if (bytes[i] !== OP_FALSE || bytes[i + 1] !== OP_IF) continue

    const markerLength = bytes[i + 2]
    if (markerLength !== 3) continue
    if (bytes[i + 3] !== 0x6f || bytes[i + 4] !== 0x72 || bytes[i + 5] !== 0x64) {
      continue
    }

    // Envelopes may contain nested conditionals. Walk opcodes/pushdata rather
    // than byte-searching for 0x68 inside inscription content.
    let depth = 1
    let at = i + 6
    while (at < bytes.length) {
      const op = bytes[at]!
      at += 1
      if (op >= 1 && op <= 75) {
        at += op
      } else if (op === 0x4c) {
        const len = bytes[at]
        if (len == null) break
        at += 1 + len
      } else if (op === 0x4d) {
        const lo = bytes[at]
        const hi = bytes[at + 1]
        if (lo == null || hi == null) break
        at += 2 + lo + (hi << 8)
      } else if (op === OP_IF) {
        depth += 1
      } else if (op === OP_ENDIF) {
        depth -= 1
        if (depth === 0) return true
      }
      if (at > bytes.length) break
    }
  }
  return false
}

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
