import { describe, expect, it } from 'vitest'
import { B_PROTOCOL_PREFIX, decodeBProtocol } from './bProtocol'
import { hasOrdEnvelope, parseOrdEnvelope } from './ordinalOwnership'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function push(data: Uint8Array): string {
  const payload = [...data].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (data.length <= 75) return data.length.toString(16).padStart(2, '0') + payload
  throw new Error('push too long')
}

function encodeText(s: string): string {
  return push(new TextEncoder().encode(s))
}

function bProtocolScript(body: Uint8Array, media = 'image/png'): string {
  return (
    '006a' +
    encodeText(B_PROTOCOL_PREFIX) +
    push(body) +
    encodeText(media) +
    encodeText('binary') +
    encodeText('mark.png')
  )
}

describe('decodeBProtocol', () => {
  it('reads OP_FALSE OP_RETURN B prefix + image body, not an ord envelope', () => {
    const script = bProtocolScript(PNG)
    expect(script.startsWith('006a')).toBe(true)
    const decoded = decodeBProtocol(script)
    expect(decoded).toMatchObject({
      prefix: B_PROTOCOL_PREFIX,
      mediaType: 'image/png',
      encoding: 'binary',
      filename: 'mark.png',
    })
    expect(decoded?.data).toEqual(PNG)
    expect(hasOrdEnvelope(script)).toBe(false)
    expect(parseOrdEnvelope(script)).toBeNull()
  })
})

