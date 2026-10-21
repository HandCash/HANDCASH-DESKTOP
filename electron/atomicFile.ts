import fs from 'node:fs'
import path from 'node:path'

/** Temp files are `<target>.<pid>.tmp` beside their target, so a rename never crosses a volume. */
export function tempPathFor(file: string): string {
  return `${file}.${process.pid}.tmp`
}

function isTempName(baseName: string, name: string): boolean {
  return name.startsWith(`${baseName}.`) && /^\.\d+\.tmp$/.test(name.slice(baseName.length))
}

export function isDiskFull(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOSPC' || code === 'EDQUOT'
}

function removeQuietly(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch {
    /* already gone */
  }
}

/** A rename is only durable on POSIX once its directory is committed too. */
export function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function writeSyncedTemp(tmp: string, data: string | Uint8Array, mode: number): void {
  const fd = fs.openSync(tmp, 'w', mode)
  try {
    if (typeof data === 'string') fs.writeFileSync(fd, data, 'utf8')
    else fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Replace `file` with `data` so a reader sees the old bytes or the new ones,
 * never a mix: temp file, fsync, rename over, fsync the directory. Any failure
 * before the rename (a full disk included) removes the temp file and leaves the
 * old file untouched. `previous` names a hard link that keeps the replaced
 * version as a fallback copy.
 */
export function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts: { mode?: number; previous?: string } = {},
): WriteResult {
  const tmp = tempPathFor(file)
  try {
    writeSyncedTemp(tmp, data, opts.mode ?? 0o600)
    if (opts.previous) keepPrevious(file, opts.previous)
    fs.renameSync(tmp, file)
  } catch (err) {
    removeQuietly(tmp)
    throw err
  }
  return commitDirectory(file)
}

/**
 * Once the rename or link has happened the new file is in place, so a failed
 * directory sync is reported rather than thrown: throwing would claim a write
 * failed that readers already see.
 */
export type WriteResult = { directorySynced: true } | { directorySynced: false; error: unknown }

function commitDirectory(file: string): WriteResult {
  try {
    syncDirectory(path.dirname(file))
    return { directorySynced: true }
  } catch (error) {
    return { directorySynced: false, error }
  }
}

/** A volume without hard links just goes without the fallback copy; the write itself stays atomic. */
function keepPrevious(file: string, previous: string): void {
  removeQuietly(previous)
  try {
    fs.linkSync(file, previous)
  } catch {
    /* no previous version, or no hard links here */
  }
}

/**
 * Create `file` with `data`, failing with EEXIST if it already exists. The file
 * appears complete or not at all: the bytes are synced under a temp name, then
 * hard-linked into place.
 */
export function writeFileExclusive(file: string, data: Uint8Array, opts: { mode?: number } = {}): WriteResult {
  const tmp = tempPathFor(file)
  try {
    writeSyncedTemp(tmp, data, opts.mode ?? 0o600)
    fs.linkSync(tmp, file)
  } finally {
    removeQuietly(tmp)
  }
  return commitDirectory(file)
}

export type TempFile = { path: string; target: string; mtimeMs: number }

/** Temp files a crashed or failed write left beside `<dir>/<baseName>`, or beside any target in `dir` when no base name is given. */
export function listTempFiles(dir: string, baseName?: string): TempFile[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: TempFile[] = []
  for (const name of names) {
    const match = /^(.+)\.\d+\.tmp$/.exec(name)
    if (!match) continue
    if (baseName !== undefined && !isTempName(baseName, name)) continue
    const file = path.join(dir, name)
    try {
      out.push({ path: file, target: path.join(dir, match[1]!), mtimeMs: fs.statSync(file).mtimeMs })
    } catch {
      /* removed meanwhile */
    }
  }
  return out
}

export function removeTempFiles(files: readonly TempFile[]): number {
  let removed = 0
  for (const file of files) {
    if (file.path.endsWith('.tmp')) {
      removeQuietly(file.path)
      removed++
    }
  }
  return removed
}
