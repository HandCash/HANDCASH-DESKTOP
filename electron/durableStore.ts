import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log'

type Store = Record<string, string>

function storePath(): string {
  return path.join(app.getPath('userData'), 'durable-prefs.json')
}

function readStore(): Store {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Store = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  const file = storePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(store, null, 2), 'utf8')
}

export function durableGet(key: string): string | null {
  if (typeof key !== 'string' || !key) return null
  return readStore()[key] ?? null
}

export function durableSet(key: string, value: string): boolean {
  if (typeof key !== 'string' || !key || typeof value !== 'string') return false
  try {
    const store = readStore()
    store[key] = value
    writeStore(store)
    return true
  } catch (err) {
    log.error('durableSet failed', err)
    return false
  }
}

export function durableRemove(key: string): boolean {
  if (typeof key !== 'string' || !key) return false
  try {
    const store = readStore()
    if (!(key in store)) return true
    delete store[key]
    writeStore(store)
    return true
  } catch (err) {
    log.error('durableRemove failed', err)
    return false
  }
}
