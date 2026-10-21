import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSaveBackupPayload, saveBackupFile } from './backupFile.js'

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

let dir = ''
const bytes = new TextEncoder().encode('# Slice 1\nshare-bytes\n')

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handcash-backup-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('saveBackupFile', () => {
  it('reports nothing saved when the dialog is cancelled', async () => {
    const result = await saveBackupFile({ filename: 'slice.txt', bytes, choosePath: async () => null })

    expect(result).toEqual({ ok: true, saved: false })
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('reports saved only with the file on disk byte for byte', async () => {
    const target = path.join(dir, 'slice.txt')
    const result = await saveBackupFile({ filename: 'slice.txt', bytes, choosePath: async () => target })

    expect(result).toEqual({ ok: true, saved: true, path: target, bytes: bytes.byteLength })
    expect(new Uint8Array(fs.readFileSync(target))).toEqual(bytes)
    expect(fs.readdirSync(dir)).toEqual(['slice.txt'])
  })

  it('keeps the file it was replacing and leaves no partial file when the disk is full', async () => {
    const target = path.join(dir, 'slice.txt')
    fs.writeFileSync(target, 'earlier slice')
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    })

    const result = await saveBackupFile({ filename: 'slice.txt', bytes, choosePath: async () => target })

    expect(result).toEqual({ ok: false, error: 'The disk is full. Nothing was saved.' })
    expect(fs.readFileSync(target, 'utf8')).toBe('earlier slice')
    expect(fs.readdirSync(dir)).toEqual(['slice.txt'])
  })

  it('does not report saved when the file reads back different', async () => {
    const target = path.join(dir, 'slice.txt')
    vi.spyOn(fs, 'readFileSync').mockReturnValueOnce(Buffer.from('truncated'))

    const result = await saveBackupFile({ filename: 'slice.txt', bytes, choosePath: async () => target })

    expect(result.ok).toBe(false)
  })
})

describe('parseSaveBackupPayload', () => {
  it('accepts bytes with a filename and strips path separators', () => {
    expect(parseSaveBackupPayload({ filename: '../a/b.txt', bytes })).toEqual({ filename: '..-a-b.txt', bytes })
  })

  it('rejects empty or non-byte payloads', () => {
    expect(parseSaveBackupPayload({ filename: 'a.txt', bytes: new Uint8Array() })).toBeNull()
    expect(parseSaveBackupPayload({ filename: 'a.txt', bytes: 'text' })).toBeNull()
    expect(parseSaveBackupPayload({ filename: ' ', bytes })).toBeNull()
  })
})
