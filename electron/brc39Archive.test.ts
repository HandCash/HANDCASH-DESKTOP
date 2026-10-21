import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData = ''

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}))

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const IDENTITY = '02' + 'ab'.repeat(32)

async function loadArchive() {
  vi.resetModules()
  return import('./brc39Archive.js')
}

function snapshotBytes(seed: string): Uint8Array {
  return new Uint8Array(Buffer.from(seed.repeat(64)))
}

function identityDir(): string {
  return path.join(userData, 'brc39-archive', IDENTITY.slice(0, 64))
}

function nameFor(exportedAt: number, bytes: Uint8Array): string {
  return `${exportedAt}-${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.brc39`
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'handcash-archive-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('BRC-39 archive', () => {
  it('leaves no partial snapshot when the disk fills mid-write', async () => {
    const { listArchiveForIdentity, writeBrc39ArchiveSnapshot } = await loadArchive()
    vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    })

    expect(() => writeBrc39ArchiveSnapshot({ identityKey: IDENTITY, bytes: snapshotBytes('a'), exportedAt: 1000 })).toThrow(
      /ENOSPC/,
    )

    expect(listArchiveForIdentity(IDENTITY)).toEqual([])
    expect(fs.readdirSync(identityDir())).toEqual([])
  })

  it('recovers a complete interrupted snapshot on start and removes incomplete ones', async () => {
    const { listArchiveForIdentity, sweepBrc39ArchiveTemps } = await loadArchive()
    const complete = snapshotBytes('b')
    const partial = snapshotBytes('c')
    fs.mkdirSync(identityDir(), { recursive: true })
    fs.writeFileSync(path.join(identityDir(), `${nameFor(2000, complete)}.900.tmp`), complete)
    fs.writeFileSync(path.join(identityDir(), `${nameFor(3000, partial)}.901.tmp`), partial.slice(0, 40))

    expect(sweepBrc39ArchiveTemps()).toEqual({ adopted: 1, removed: 2 })

    expect(listArchiveForIdentity(IDENTITY).map((entry) => entry.id)).toEqual([nameFor(2000, complete)])
    expect(fs.readdirSync(identityDir()).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses to return a snapshot whose bytes no longer match its name', async () => {
    const { readBrc39ArchiveSnapshot, writeBrc39ArchiveSnapshot } = await loadArchive()
    const { meta } = writeBrc39ArchiveSnapshot({ identityKey: IDENTITY, bytes: snapshotBytes('d'), exportedAt: 4000 })
    fs.truncateSync(meta.path, 70)

    expect(() => readBrc39ArchiveSnapshot({ identityKey: IDENTITY, id: meta.id })).toThrow(/incomplete or damaged/)
  })

  it('still writes once and dedupes identical content', async () => {
    const { writeBrc39ArchiveSnapshot } = await loadArchive()
    const bytes = snapshotBytes('e')

    expect(writeBrc39ArchiveSnapshot({ identityKey: IDENTITY, bytes, exportedAt: 5000 }).created).toBe(true)
    expect(writeBrc39ArchiveSnapshot({ identityKey: IDENTITY, bytes, exportedAt: 6000 }).created).toBe(false)
    expect(fs.readdirSync(identityDir())).toEqual([nameFor(5000, bytes)])
  })
})
