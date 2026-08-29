/**
 * B protocol (`19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut`) file output.
 *
 * Decode only. Mint Studio writes these as token icons (OP_FALSE OP_RETURN).
 * Not an ord envelope and not a 1sat / image/* sibling — do not file in basket `1sat`.
 */
export const B_PROTOCOL_PREFIX = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'

export type DecodedBProtocol = {
  prefix: string
  data: Uint8Array
  mediaType: string
  encoding: string
  filename?: string
}

function hexToBytes(hex: string): number[] | null {
  const n = hex.trim().toLowerCase()
  if (!n || n.length % 2 !== 0 || !/^[0-9a-f]+$/.test(n)) return null
  const out: number[] = []
  for (let i = 0; i < n.length; i += 2) {
    out.push(Number.parseInt(n.slice(i, i + 2), 16))
  }
  return out
}

function readPush(bytes: number[], at: number): { data: number[]; next: number } | null {
  if (at >= bytes.length) return null
  const op = bytes[at]!
  if (op === 0x00) return { data: [], next: at + 1 }
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

export function decodeBProtocol(scriptHex: string | undefined): DecodedBProtocol | null {
  if (!scriptHex) return null
  const bytes = hexToBytes(scriptHex)
  if (!bytes || bytes.length < 4) return null
  if (bytes[0] !== 0x00 || bytes[1] !== 0x6a) return null
  const pushes: Uint8Array[] = []
  let at = 2
  while (at < bytes.length) {
    const push = readPush(bytes, at)
    if (!push) return null
    pushes.push(Uint8Array.from(push.data))
    at = push.next
  }
  if (pushes.length < 4) return null
  const prefix = new TextDecoder().decode(pushes[0])
  if (prefix !== B_PROTOCOL_PREFIX) return null
  const mediaType = new TextDecoder().decode(pushes[2])
  const encoding = new TextDecoder().decode(pushes[3])
  const filename =
    pushes[4] && pushes[4].length ? new TextDecoder().decode(pushes[4]) : undefined
  return {
    prefix,
    data: pushes[1]!,
    mediaType,
    encoding,
    ...(filename ? { filename } : {}),
  }
}
