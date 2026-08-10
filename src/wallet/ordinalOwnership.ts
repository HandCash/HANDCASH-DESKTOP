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
const OP_0 = 0x00
const OP_1 = 0x51
const OP_3 = 0x53

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

function readPush(bytes: number[], at: number): { data: number[]; next: number } | null {
  if (at >= bytes.length) return null
  const op = bytes[at]!
  if (op >= 1 && op <= 75) {
    const end = at + 1 + op
    if (end > bytes.length) return null
    return { data: bytes.slice(at + 1, end), next: end }
  }
  if (op === 0x4c) {
    const len = bytes[at + 1]
    if (len == null) return null
    const end = at + 2 + len
    if (end > bytes.length) return null
    return { data: bytes.slice(at + 2, end), next: end }
  }
  if (op === 0x4d) {
    const lo = bytes[at + 1]
    const hi = bytes[at + 2]
    if (lo == null || hi == null) return null
    const len = lo + (hi << 8)
    const end = at + 3 + len
    if (end > bytes.length) return null
    return { data: bytes.slice(at + 3, end), next: end }
  }
  if (op === 0x4e) {
    const b0 = bytes[at + 1]
    const b1 = bytes[at + 2]
    const b2 = bytes[at + 3]
    const b3 = bytes[at + 4]
    if (b0 == null || b1 == null || b2 == null || b3 == null) return null
    const len = b0 + (b1 << 8) + (b2 << 16) + (b3 << 24)
    const end = at + 5 + len
    if (end > bytes.length || len < 0) return null
    return { data: bytes.slice(at + 5, end), next: end }
  }
  return null
}

function fieldTag(op: number, push: number[] | null): number | null {
  if (op === OP_0 || (push && push.length === 1 && push[0] === 0)) return 0
  if (op === OP_1 || (push && push.length === 1 && push[0] === 1)) return 1
  if (op === OP_3 || (push && push.length === 1 && push[0] === 3)) return 3
  if (op >= 0x52 && op <= 0x60) return op - 0x50 // OP_2..OP_16
  if (push && push.length === 1 && push[0]! <= 16) return push[0]!
  return null
}

function parentOutpointFromField3(data: number[]): string | null {
  if (data.length === 36) {
    const txid = data
      .slice(0, 32)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    const vout = data[32]! + (data[33]! << 8) + (data[34]! << 16) + (data[35]! << 24)
    return `${txid}_${vout >>> 0}`
  }
  if (data.length === 32) {
    const txid = data.map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${txid}_0`
  }
  try {
    const text = new TextDecoder().decode(Uint8Array.from(data)).trim()
    const m = text.match(/^([0-9a-f]{64})[_.](\d+)$/i)
    if (m) return `${m[1]!.toLowerCase()}_${m[2]}`
  } catch {
    /* ignore */
  }
  return null
}

export type ParsedOrdEnvelope = {
  contentType?: string
  body: Uint8Array
  /** BRC-160 field 3 parent outpoint (`txid_vout`), when present. */
  parent?: string
}

/**
 * Parse the first complete `ord` envelope in a locking script.
 * Field 0 (body) terminates the field list per BRC-160.
 */
export function parseOrdEnvelope(scriptHex: string | undefined): ParsedOrdEnvelope | null {
  if (!scriptHex) return null
  const bytes = hexBytes(scriptHex)
  if (!bytes) return null

  for (let i = 0; i + 5 < bytes.length; i++) {
    if (bytes[i] !== OP_FALSE || bytes[i + 1] !== OP_IF) continue
    const markerLength = bytes[i + 2]
    if (markerLength !== 3) continue
    if (bytes[i + 3] !== 0x6f || bytes[i + 4] !== 0x72 || bytes[i + 5] !== 0x64) {
      continue
    }

    let at = i + 6
    let contentType: string | undefined
    let parent: string | undefined

    while (at < bytes.length) {
      const op = bytes[at]!
      if (op === OP_ENDIF) break

      let tag: number | null = null
      let next = at + 1
      if (op === OP_0 || op === OP_1 || op === OP_3 || (op >= 0x52 && op <= 0x60)) {
        tag = fieldTag(op, null)
      } else {
        const tagPush = readPush(bytes, at)
        if (!tagPush) break
        tag = fieldTag(op, tagPush.data)
        next = tagPush.next
      }
      if (tag == null) break

      const value = readPush(bytes, next)
      if (!value) break
      at = value.next

      if (tag === 1) {
        contentType = new TextDecoder().decode(Uint8Array.from(value.data))
      } else if (tag === 3) {
        parent = parentOutpointFromField3(value.data) ?? parent
      } else if (tag === 0) {
        if (at >= bytes.length || bytes[at] !== OP_ENDIF) return null
        return {
          body: Uint8Array.from(value.data),
          ...(contentType ? { contentType } : {}),
          ...(parent ? { parent } : {}),
        }
      }
    }
  }
  return null
}

/**
 * True when a locking script contains a structurally complete first 1Sat
 * inscription envelope: `OP_FALSE OP_IF <"ord"> ... OP_ENDIF`.
 */
export function hasOrdEnvelope(scriptHex: string | undefined): boolean {
  if (parseOrdEnvelope(scriptHex)) return true
  return hasOrdEnvelopeStructure(scriptHex)
}

/** Structural completeness without requiring a parseable field-0 body. */
function hasOrdEnvelopeStructure(scriptHex: string | undefined): boolean {
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

  let at = script.indexOf(expected)
  while (at >= 0) {
    if (at % 2 === 0) return true
    at = script.indexOf(expected, at + 1)
  }
  return false
}
