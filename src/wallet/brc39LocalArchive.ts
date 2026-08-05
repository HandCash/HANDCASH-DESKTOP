/**
 * Renderer bridge for the append-only on-device BRC-39 (UTXO) archive.
 * Snapshots are write-once under Electron userData — never overwritten.
 */
import { getActiveWallet } from './session'
import { appendAppLog } from './appLog'

export type LocalBrc39ArchiveMeta = {
  id: string
  identityKey: string
  exportedAt: number
  bytes: number
  sha256: string
  path: string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Persist a write-once local snapshot. No-op outside Electron. */
export async function archiveBrc39Locally(args: {
  identityKey: string
  bytes: Uint8Array
  exportedAt?: number
}): Promise<LocalBrc39ArchiveMeta | null> {
  const api = window.handcash?.archiveBrc39Snapshot
  if (!api) return null
  try {
    const result = await api({
      identityKey: args.identityKey,
      bytesBase64: bytesToBase64(args.bytes),
      exportedAt: args.exportedAt,
    })
    appendAppLog(
      'info',
      `[utxo-archive] ${result.created ? 'wrote' : 'deduped'} ${result.meta.bytes} bytes → ${result.meta.id}`,
    )
    return result.meta
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendAppLog('warn', `[utxo-archive] write failed: ${msg}`)
    return null
  }
}

export async function listLocalBrc39Archive(
  identityKey?: string,
): Promise<LocalBrc39ArchiveMeta[]> {
  const id = identityKey ?? getActiveWallet()?.identityKey
  if (!id || !window.handcash?.listBrc39Archive) return []
  try {
    return await window.handcash.listBrc39Archive(id)
  } catch {
    return []
  }
}

export async function readLocalBrc39Archive(args: {
  identityKey: string
  id: string
}): Promise<Uint8Array> {
  const api = window.handcash?.readBrc39Archive
  if (!api) throw new Error('Local UTXO archive is only available in Desktop')
  const result = await api(args)
  return base64ToBytes(result.bytesBase64)
}
