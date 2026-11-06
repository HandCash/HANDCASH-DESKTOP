import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hash160, sha256d } from './hashes'

const digest = (name: string, bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash(name).update(bytes).digest())
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

describe('permissive hash adapters', () => {
  it('matches fixed empty-input composition vectors', () => {
    expect(hex(sha256d(new Uint8Array()))).toBe('5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456')
    expect(hex(hash160(new Uint8Array()))).toBe('b472a266d0bd89c13706a4132ccfb16f7c3b9fcb')
  })

  it.each([0, 1, 31, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1024, 65536])(
    'matches the independent Node crypto oracle for %i bytes without changing input',
    (length) => {
      const storage = Uint8Array.from({ length: length + 6 }, (_, i) => (i * 37 + 11) % 256)
      const bytes = storage.subarray(3, length + 3)
      const before = storage.slice()
      const sha = digest('sha256', bytes)
      expect(sha256d(bytes)).toEqual(digest('sha256', sha))
      expect(hash160(bytes)).toEqual(digest('ripemd160', sha))
      expect(storage).toEqual(before)
    },
  )

  it('returns independent result buffers', () => {
    for (const hash of [sha256d, hash160]) {
      const bytes = new Uint8Array([1, 2, 3])
      const first = hash(bytes)
      const expected = first.slice()
      first.fill(0)
      expect(hash(bytes)).toEqual(expected)
      expect(bytes).toEqual(new Uint8Array([1, 2, 3]))
    }
  })
})
