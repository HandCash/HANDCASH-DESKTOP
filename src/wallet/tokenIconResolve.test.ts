import { describe, expect, it } from 'vitest'
import { B_PROTOCOL_PREFIX, decodeBProtocol } from './bProtocol'
import { cacheTokenIconFromBeef } from './tokenIconResolve'
import { getTokenIconDataUrl } from './tokenIconCache'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function push(data: Uint8Array): string {
  const payload = [...data].map((b) => b.toString(16).padStart(2, '0')).join('')
  if (data.length <= 75) return data.length.toString(16).padStart(2, '0') + payload
  throw new Error('push too long')
}

function encodeText(s: string): string {
  return push(new TextEncoder().encode(s))
}

describe('tokenIconResolve B-protocol', () => {
  it('hydrates an image mime from a B-protocol script', () => {
    const script = (
      '006a' +
      encodeText(B_PROTOCOL_PREFIX) +
      push(PNG) +
      encodeText('image/png') +
      encodeText('binary')
    )
    expect(decodeBProtocol(script)?.mediaType).toBe('image/png')
    const txid = 'ab'.repeat(32)
    const outpoint = `${txid}_1`
    const url = cacheTokenIconFromBeef(outpoint, {
      findTxid: () => ({
        tx: {
          outputs: [
            { lockingScript: `76a914${'11'.repeat(20)}88ac` },
            { lockingScript: script },
          ],
        },
      }),
    })
    expect(url?.startsWith('data:image/png;base64,')).toBe(true)
    expect(getTokenIconDataUrl(outpoint)?.startsWith('data:image/png')).toBe(true)
  })
})
