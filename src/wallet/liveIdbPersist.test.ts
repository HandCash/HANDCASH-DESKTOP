import { describe, expect, it } from 'vitest'

import { liveIdbCodec } from './liveIdbPersist'

describe('liveIdbCodec', () => {
  it('roundtrips dates and bytes used by toolbox IDB rows', () => {
    const src = {
      when: new Date('2026-01-02T03:04:05.000Z'),
      raw: new Uint8Array([7, 8, 9]),
      nested: [{ n: 1 }],
    }
    const back = liveIdbCodec.decode(liveIdbCodec.encode(src)) as typeof src
    expect(back.when.toISOString()).toBe(src.when.toISOString())
    expect(Array.from(back.raw)).toEqual([7, 8, 9])
    expect(back.nested).toEqual([{ n: 1 }])
  })
})
