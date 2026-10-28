import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''

const IDENTITY = '02' + 'ab'.repeat(32)
const ID = 'c'.repeat(32)

async function load() {
  vi.resetModules()
  process.env.HANDCASH_USER_DATA = userData
  return import('./callRecordings.js')
}

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill)

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'handcash-recordings-'))
})

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('call recordings on disk', () => {
  it('keeps sealed parts in order, write-once, with the meta that closes them', async () => {
    const store = await load()
    store.appendRecordingPart(IDENTITY, ID, 1, bytes(3, 2))
    store.appendRecordingPart(IDENTITY, ID, 0, bytes(2, 1))
    expect(() => store.appendRecordingPart(IDENTITY, ID, 0, bytes(2, 9))).toThrow()
    store.finishRecording(IDENTITY, ID, bytes(4, 7))
    expect(() => store.finishRecording(IDENTITY, ID, bytes(4, 8))).toThrow()

    const read = store.readRecording(IDENTITY, ID)
    expect(read.parts.map((p) => [...p])).toEqual([
      [1, 1],
      [2, 2, 2],
    ])
    expect([...read.meta!]).toEqual([7, 7, 7, 7])
    const [entry] = store.listRecordings(IDENTITY)
    expect(entry).toMatchObject({ id: ID, parts: 2, bytes: 5 })
    const file = path.join(userData, 'call-recordings', IDENTITY, ID, '000000.part')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('stops at a missing part rather than splicing around it', async () => {
    const store = await load()
    store.appendRecordingPart(IDENTITY, ID, 0, bytes(1, 1))
    store.appendRecordingPart(IDENTITY, ID, 2, bytes(1, 3))
    expect(store.readRecording(IDENTITY, ID).parts).toHaveLength(1)
  })

  it('refuses bad keys, ids, part numbers and sizes, and keeps accounts apart', async () => {
    const store = await load()
    expect(() => store.appendRecordingPart('../x', ID, 0, bytes(1, 1))).toThrow()
    expect(() => store.appendRecordingPart(IDENTITY, '../' + ID, 0, bytes(1, 1))).toThrow()
    expect(() => store.appendRecordingPart(IDENTITY, ID, -1, bytes(1, 1))).toThrow()
    expect(() => store.appendRecordingPart(IDENTITY, ID, 1.5, bytes(1, 1))).toThrow()
    expect(() => store.appendRecordingPart(IDENTITY, ID, 0, new Uint8Array(0))).toThrow()
    expect(() => store.appendRecordingPart(IDENTITY, ID, 0, 'text')).toThrow()
    expect(() => store.appendRecordingPart(IDENTITY, ID, 0, bytes(store.RECORDING_PART_MAX_BYTES + 1, 0))).toThrow()
    store.appendRecordingPart(IDENTITY, ID, 0, bytes(1, 1))
    expect(store.listRecordings('03' + 'cd'.repeat(32))).toEqual([])
  })

  it('deletes a recording', async () => {
    const store = await load()
    store.appendRecordingPart(IDENTITY, ID, 0, bytes(1, 1))
    store.deleteRecording(IDENTITY, ID)
    expect(store.listRecordings(IDENTITY)).toEqual([])
  })
})
