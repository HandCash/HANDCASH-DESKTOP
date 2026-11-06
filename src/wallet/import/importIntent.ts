import type { ImportSourceKind } from './importSource'

/**
 * A request from outside Settings → Import (the HandCash migrate page over the
 * bridge) to open the add form for one source kind. It waits here until the
 * Import panel is idle enough to take it, so it never interrupts a scan,
 * sweep or half-typed secret.
 */
let pending: ImportSourceKind | null = null
const listeners = new Set<(kind: ImportSourceKind | null) => void>()

export function requestImportKind(kind: ImportSourceKind): void {
  pending = kind
  for (const cb of listeners) cb(pending)
}

export function takeImportIntent(): ImportSourceKind | null {
  const kind = pending
  pending = null
  return kind
}

export function subscribeImportIntent(cb: (kind: ImportSourceKind | null) => void): () => void {
  listeners.add(cb)
  cb(pending)
  return () => {
    listeners.delete(cb)
  }
}

// A received encrypted export opens its saved source, never an empty key form.
let receivedSource: string | null = null
const sourceListeners = new Set<() => void>()
export function requestImportedSource(sourceId: string): void {
  receivedSource = sourceId
  for (const cb of sourceListeners) cb()
}
export function peekImportedSource(): string | null { return receivedSource }
export function takeImportedSource(): string | null {
  const id = receivedSource
  receivedSource = null
  return id
}
export function subscribeReceivedSource(cb: () => void): () => void {
  sourceListeners.add(cb)
  cb()
  return () => { sourceListeners.delete(cb) }
}
