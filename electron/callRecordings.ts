/**
 * Call recordings, on this device only: userData/call-recordings/{identity}/{id}/
 * holds numbered parts and a meta file, each sealed by the renderer before it
 * arrives, so this side never holds a key or a plaintext byte. Parts are
 * write-once, and nothing here sends anything anywhere.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isDiskFull, writeFileExclusive } from './atomicFile.js'
import { hostLog as log } from './hostLog.js'
import { getUserDataPath } from './userDataPath.js'

export const RECORDING_PART_MAX_BYTES = 16 * 1024 * 1024
export const RECORDING_PARTS_MAX = 100_000

const RECORDING_ID = /^[a-f0-9]{32}$/
const PART_NAME = /^(\d{6})\.part$/
const META_NAME = 'meta.sealed'

export type CallRecordingEntry = {
  id: string
  parts: number
  bytes: number
  /** The sealed meta, once the recording finished. */
  meta: Uint8Array | null
  modifiedAt: number
}

function identityDir(identityKey: unknown): string {
  if (typeof identityKey !== 'string' || !/^0[23][a-f0-9]{64}$/i.test(identityKey)) {
    throw new Error('Invalid identity key for call recordings')
  }
  return path.join(getUserDataPath(), 'call-recordings', identityKey.toLowerCase())
}

function recordingDir(identityKey: unknown, id: unknown): string {
  if (typeof id !== 'string' || !RECORDING_ID.test(id)) throw new Error('Invalid call recording id')
  return path.join(identityDir(identityKey), id)
}

function sealedBytes(data: unknown): Uint8Array {
  if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > RECORDING_PART_MAX_BYTES) {
    throw new Error('Invalid call recording part')
  }
  return data
}

function writeOnce(file: string, bytes: Uint8Array): void {
  try {
    const result = writeFileExclusive(file, bytes)
    if (!result.directorySynced) log.warn('call recording written, but its folder could not be synced', file)
  } catch (err) {
    if (isDiskFull(err)) log.error('call recording not written: the disk is full', file)
    throw err
  }
}

function partsOf(dir: string): { seq: number; file: string }[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const parts: { seq: number; file: string }[] = []
  for (const name of names) {
    const m = PART_NAME.exec(name)
    if (m) parts.push({ seq: Number(m[1]), file: path.join(dir, name) })
  }
  parts.sort((a, b) => a.seq - b.seq)
  // A gap means a lost part: playback stops before it rather than splicing around it.
  const contiguous = parts.findIndex((p, i) => p.seq !== i)
  return contiguous === -1 ? parts : parts.slice(0, contiguous)
}

function readIfThere(file: string): Uint8Array | null {
  try {
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

export function appendRecordingPart(identityKey: unknown, id: unknown, seq: unknown, data: unknown): void {
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq >= RECORDING_PARTS_MAX) {
    throw new Error('Invalid call recording part number')
  }
  const bytes = sealedBytes(data)
  const dir = recordingDir(identityKey, id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeOnce(path.join(dir, `${String(seq).padStart(6, '0')}.part`), bytes)
}

/** The sealed meta closes a recording; it is written once. */
export function finishRecording(identityKey: unknown, id: unknown, meta: unknown): void {
  const bytes = sealedBytes(meta)
  const dir = recordingDir(identityKey, id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeOnce(path.join(dir, META_NAME), bytes)
}

export function listRecordings(identityKey: unknown): CallRecordingEntry[] {
  const root = identityDir(identityKey)
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  const out: CallRecordingEntry[] = []
  for (const id of names) {
    if (!RECORDING_ID.test(id)) continue
    const dir = path.join(root, id)
    const parts = partsOf(dir)
    let bytes = 0
    let modifiedAt = 0
    for (const part of parts) {
      const stat = fs.statSync(part.file)
      bytes += stat.size
      modifiedAt = Math.max(modifiedAt, stat.mtimeMs)
    }
    out.push({ id, parts: parts.length, bytes, meta: readIfThere(path.join(dir, META_NAME)), modifiedAt })
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export function readRecording(identityKey: unknown, id: unknown): { meta: Uint8Array | null; parts: Uint8Array[] } {
  const dir = recordingDir(identityKey, id)
  return { meta: readIfThere(path.join(dir, META_NAME)), parts: partsOf(dir).map((p) => fs.readFileSync(p.file)) }
}

export function deleteRecording(identityKey: unknown, id: unknown): void {
  fs.rmSync(recordingDir(identityKey, id), { recursive: true, force: true })
}
