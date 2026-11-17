import { PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { BNT_MIN_SILENCE_SECONDS, decodeBntPayload, encodeBntPayload } from './payload'
import { HANDLE_CARD_MODEL_TYPE, handleCardIptFields, type HandleCardIptArgs } from './handleCard'

const issuer = PrivateKey.fromRandom().toPublicKey().toString()
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const glb = Uint8Array.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 9, 9])

const args = (over: Partial<HandleCardIptArgs> = {}): HandleCardIptArgs => ({
  handle: '$BrandonC',
  iss: [issuer],
  m: 1,
  bcn: `${'ab'.repeat(32)}_0`,
  sil: BNT_MIN_SILENCE_SECONDS,
  rel: 'cd'.repeat(20),
  image: { mediaType: 'image/png', bytes: png },
  glb,
  ...over,
})

describe('handle card IPT token', () => {
  it('carries the handle, card image and GLB through a BRC-255 payload round trip', () => {
    const fields = handleCardIptFields(args())
    expect(fields).toMatchObject({ mode: 'countersign', kind: 'item', hdl: 'BrandonC', name: '$BrandonC identity key', ctype: HANDLE_CARD_MODEL_TYPE })
    const decoded = decodeBntPayload(Uint8Array.from(encodeBntPayload(fields)))
    expect(decoded?.hdl).toBe('BrandonC')
    expect(decoded?.icon?.mediaType).toBe('image/png')
    expect([...decoded!.icon!.bytes]).toEqual([...png])
    expect(decoded?.ctype).toBe('model/gltf-binary')
    expect([...decoded!.c!]).toEqual([...glb])
    expect(decoded?.bcn).toBe(fields.bcn)
  })

  it('refuses a non-GLB model, a non-image picture and an oversized icon', () => {
    expect(() => handleCardIptFields(args({ glb: Uint8Array.from([1, 2, 3, 4]) }))).toThrow(/GLB/)
    expect(() => handleCardIptFields(args({ image: { mediaType: 'text/plain', bytes: png } }))).toThrow(/image/)
    expect(() => handleCardIptFields(args({ image: { mediaType: 'image/png', bytes: new Uint8Array(96 * 1024 + 1) } }))).toThrow(/96 KiB/)
  })

  it('still needs exactly one release', () => {
    expect(() => handleCardIptFields(args({ rel: undefined }))).toThrow(/exactly one release/)
  })
})
