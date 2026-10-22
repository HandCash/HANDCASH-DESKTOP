import 'fake-indexeddb/auto'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { dumpLiveWalletState, liveIdbCodec } from './liveIdbPersist'

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

describe('dumpLiveWalletState', () => {
  it('writes the dump atomically and readable only by its owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-live-idb-'))
    try {
      const path = join(dir, 'live-idb.json')
      await dumpLiveWalletState(path)
      // Windows has no POSIX mode bits; stat reports 0o666 for any writable file.
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(readdirSync(dir)).toEqual(['live-idb.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
