/**
 * Shared ordinal inscription PushData / envelope helpers.
 *
 * Used by BSV-21 and 1Sat-FT locking-script builders — hex encoding only.
 */
import { bytesToHex } from './hexBinary'

export const OP_FALSE = '00'
export const OP_IF = '63'
export const OP_ENDIF = '68'
export const OP_1 = '51'
export const OP_0 = '00'

const encoder = new TextEncoder()

export function pushData(data: Uint8Array): string {
  const n = data.length
  if (n === 0) return OP_0
  const body = bytesToHex(data)
  if (n <= 75) return n.toString(16).padStart(2, '0') + body
  if (n <= 255) return `4c${n.toString(16).padStart(2, '0')}${body}`
  if (n <= 65535) {
    const lo = (n & 0xff).toString(16).padStart(2, '0')
    const hi = ((n >> 8) & 0xff).toString(16).padStart(2, '0')
    return `4d${lo}${hi}${body}`
  }
  throw new Error('Inscription body too large')
}

export function pushText(text: string): string {
  return pushData(encoder.encode(text))
}

/** `OP_FALSE OP_IF "ord" OP_1 <mime> OP_0 <body> OP_ENDIF` */
export function ordEnvelopeHex(contentType: string, body: Uint8Array): string {
  const mime = contentType.trim().toLowerCase().split(';')[0]!.trim()
  if (!mime) throw new Error('Inscription needs a content type')
  return (
    OP_FALSE +
    OP_IF +
    pushText('ord') +
    OP_1 +
    pushText(mime) +
    OP_0 +
    pushData(body) +
    OP_ENDIF
  ).toLowerCase()
}
