/**
 * Append-only on-device BRC-39 (UTXO / localState) archive.
 *
 * Snapshots are write-once files under userData/brc39-archive/{identity}/.
 * Existing files are never overwritten (wx / exclusive create). Oldest files
 * may be pruned past MAX_SNAPSHOTS_PER_IDENTITY, but a written snapshot is
 * never mutated in place.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log'

export type Brc39ArchiveMeta = {
  id: string
  identityKey: string
  exportedAt: number
  bytes: number
  sha256: string
  path: string
}

const MAX_SNAPSHOTS_PER_IDENTITY = 40

function archiveRoot(): string {
  return path.join(app.getPath('userData'), 'brc39-archive')
}

function safeIdentityDir(identityKey: string): string {
  const safe = identityKey.replace(/[^a-fA-F0-9]/gi, '').slice(0, 64)
  if (!safe || safe.length < 8) {
    throw new Error('Invalid identity key for UTXO archive')
  }
  return path.join(archiveRoot(), safe.toLowerCase())
}

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function snapshotFilename(exportedAt: number, sha256: string): string {
  return `${exportedAt}-${sha256.slice(0, 12)}.brc39`
}

function parseSnapshotName(
  identityKey: string,
  dir: string,
  name: string,
): Brc39ArchiveMeta | null {
  const m = /^(\d+)-([a-f0-9]{12})\.brc39$/i.exec(name)
  if (!m) return null
  const exportedAt = Number(m[1])
  if (!Number.isFinite(exportedAt) || exportedAt <= 0) return null
  const filePath = path.join(dir, name)
  let bytes = 0
  try {
    bytes = fs.statSync(filePath).size
  } catch {
    return null
  }
  return {
    id: name,
    identityKey,
    exportedAt,
    bytes,
    sha256: m[2]!.toLowerCase(),
    path: filePath,
  }
}

/** Prune oldest snapshots only — never rewrite remaining files. */
function pruneOldest(identityKey: string): void {
  const entries = listArchiveForIdentity(identityKey)
  if (entries.length <= MAX_SNAPSHOTS_PER_IDENTITY) return
  const drop = entries.slice(MAX_SNAPSHOTS_PER_IDENTITY)
  for (const entry of drop) {
    try {
      fs.unlinkSync(entry.path)
      log.info('brc39-archive pruned oldest', entry.id)
    } catch (err) {
      log.warn('brc39-archive prune failed', entry.id, err)
    }
  }
}

/**
 * Write a snapshot if one with this content does not already exist.
 * Returns created:false when the same bytes were already archived (idempotent).
 * Never overwrites an existing path.
 */
export function writeBrc39ArchiveSnapshot(args: {
  identityKey: string
  bytes: Uint8Array
  exportedAt?: number
}): { created: boolean; meta: Brc39ArchiveMeta } {
  const identityKey = args.identityKey.trim()
  const bytes = args.bytes
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 64) {
    throw new Error('BRC-39 snapshot too small to archive')
  }

  const exportedAt = args.exportedAt && args.exportedAt > 0 ? args.exportedAt : Date.now()
  const digest = sha256Hex(bytes)
  const dir = safeIdentityDir(identityKey)
  fs.mkdirSync(dir, { recursive: true })

  // Idempotent: identical content already on disk.
  const existing = listArchiveForIdentity(identityKey)
  for (const entry of existing) {
    try {
      const onDisk = fs.readFileSync(entry.path)
      if (sha256Hex(onDisk) === digest) {
        return { created: false, meta: { ...entry, sha256: digest } }
      }
    } catch {
      /* ignore unreadable; write a new exclusive file */
    }
  }

  const name = snapshotFilename(exportedAt, digest)
  const filePath = path.join(dir, name)

  try {
    // wx = exclusive create — fails if the path already exists (no overwrite).
    fs.writeFileSync(filePath, Buffer.from(bytes), { flag: 'wx', mode: 0o600 })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EEXIST') {
      const onDisk = fs.readFileSync(filePath)
      const onDiskSha = sha256Hex(onDisk)
      if (onDiskSha === digest) {
        const meta = parseSnapshotName(identityKey, dir, name)
        if (meta) return { created: false, meta: { ...meta, sha256: digest } }
      }
      // Same timestamp collision with different content — write under a unique name.
      const alt = snapshotFilename(exportedAt + 1, digest)
      const altPath = path.join(dir, alt)
      fs.writeFileSync(altPath, Buffer.from(bytes), { flag: 'wx', mode: 0o600 })
      pruneOldest(identityKey)
      const meta = parseSnapshotName(identityKey, dir, alt)
      if (!meta) throw new Error('Failed to record UTXO archive metadata')
      log.info('brc39-archive wrote', altPath, bytes.byteLength)
      return { created: true, meta: { ...meta, sha256: digest } }
    }
    throw err
  }

  pruneOldest(identityKey)
  const meta = parseSnapshotName(identityKey, dir, name)
  if (!meta) throw new Error('Failed to record UTXO archive metadata')
  log.info('brc39-archive wrote', filePath, bytes.byteLength)
  return { created: true, meta: { ...meta, sha256: digest } }
}

export function listArchiveForIdentity(identityKey: string): Brc39ArchiveMeta[] {
  let dir: string
  try {
    dir = safeIdentityDir(identityKey.trim())
  } catch {
    return []
  }
  if (!fs.existsSync(dir)) return []
  const out: Brc39ArchiveMeta[] = []
  for (const name of fs.readdirSync(dir)) {
    const meta = parseSnapshotName(identityKey.trim(), dir, name)
    if (meta) out.push(meta)
  }
  // Newest first.
  out.sort((a, b) => b.exportedAt - a.exportedAt)
  return out
}

export function readBrc39ArchiveSnapshot(args: {
  identityKey: string
  id: string
}): { bytes: Buffer; meta: Brc39ArchiveMeta } {
  const identityKey = args.identityKey.trim()
  const id = path.basename(args.id)
  if (!/^\d+-[a-f0-9]{12}\.brc39$/i.test(id)) {
    throw new Error('Invalid UTXO archive id')
  }
  const dir = safeIdentityDir(identityKey)
  const filePath = path.join(dir, id)
  // Resolve + ensure we stay inside the identity dir (no path escape).
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error('Invalid UTXO archive path')
  }
  if (!fs.existsSync(resolved)) throw new Error('UTXO archive snapshot not found')
  const bytes = fs.readFileSync(resolved)
  const meta = parseSnapshotName(identityKey, dir, id)
  if (!meta) throw new Error('Corrupt UTXO archive metadata')
  return { bytes, meta: { ...meta, sha256: sha256Hex(bytes) } }
}

/** Archive root path for diagnostics (never wipe on factory reset). */
export function brc39ArchiveRootPath(): string {
  return archiveRoot()
}
