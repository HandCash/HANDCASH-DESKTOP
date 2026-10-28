import { describe, expect, it } from 'vitest'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { newRecordingId, openMeta, openPart, recordingKey, sealMeta, sealPart, type RecordingMeta } from './recordingCrypto'

const PLAIN = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

describe('call recording sealing', () => {
  it('only the account that recorded opens a part, and only in its place', async () => {
    const me = new ProtoWallet(PrivateKey.fromRandom())
    const other = new ProtoWallet(PrivateKey.fromRandom())
    const id = newRecordingId()
    expect(id).toMatch(/^[a-f0-9]{32}$/)
    const key = await recordingKey(me, id)
    const sealed = await sealPart(key, id, 0, PLAIN)
    expect(await openPart(await recordingKey(me, id), id, 0, sealed)).toEqual(PLAIN)

    await expect(openPart(await recordingKey(other, id), id, 0, sealed)).rejects.toThrow()
    await expect(openPart(key, id, 1, sealed)).rejects.toThrow()
    const elsewhere = newRecordingId()
    await expect(openPart(await recordingKey(me, elsewhere), elsewhere, 0, sealed)).rejects.toThrow()
    const tampered = sealed.slice()
    tampered[tampered.length - 1]! ^= 1
    await expect(openPart(key, id, 0, tampered)).rejects.toThrow()
  })

  it('seals the meta, and reads back only well-formed meta under the right key', async () => {
    const me = new ProtoWallet(PrivateKey.fromRandom())
    const id = newRecordingId()
    const key = await recordingKey(me, id)
    const meta: RecordingMeta = { v: 1, callId: 'c1', peers: ['02' + 'a'.repeat(64)], startedAt: 1, endedAt: 2, mime: 'video/webm', video: true }
    const sealed = await sealMeta(key, id, meta)
    expect(await openMeta(key, id, sealed)).toEqual(meta)
    expect(await openMeta(await recordingKey(me, newRecordingId()), id, sealed)).toBeNull()
    expect(await openMeta(key, id, await sealPart(key, id, 'meta', new TextEncoder().encode('{"v":2}')))).toBeNull()
  })
})
