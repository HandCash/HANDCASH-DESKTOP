/**
 * Call recordings for the open account: sealed parts go to the desktop shell,
 * which keeps them under the app's own folder on this device and nowhere
 * else. Opening one reads its parts back and unseals them here, in memory, for
 * playback; nothing is ever written out in the clear.
 */

import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { getActiveWallet } from '../session'
import type { RecordingStore } from './callRecorder'
import { openMeta, openPart, recordingKey, type RecordingMeta } from './recordingCrypto'

type Bridge = Required<
  Pick<NonNullable<Window['handcash']>, 'appendCallRecording' | 'finishCallRecording' | 'readCallRecording' | 'deleteCallRecording'>
>

function bridge(): Bridge | null {
  const h = typeof window === 'undefined' ? undefined : window.handcash
  if (!h?.appendCallRecording || !h.finishCallRecording || !h.readCallRecording || !h.deleteCallRecording) return null
  return h as Bridge
}

/** Recordings need the desktop shell: the browser build has nowhere private to keep them. */
export function recordingStoreAvailable(): boolean {
  return bridge() !== null
}

function account(): { identityKey: string; rootKeyHex: string } {
  const wallet = getActiveWallet()
  if (!wallet) throw new Error('No account is open')
  return wallet
}

/** This recording's key; the account key is used here and dropped. */
export function callRecordingKey(id: string): Promise<CryptoKey> {
  return recordingKey(new ProtoWallet(PrivateKey.fromHex(account().rootKeyHex)), id)
}

/** Where the open account's sealed parts go; bound to that account for the whole recording. */
export function callRecordingStore(): RecordingStore {
  const b = bridge()
  if (!b) throw new Error('Recordings need the desktop app')
  const { identityKey } = account()
  return {
    append: (id, seq, sealed) => b.appendCallRecording(identityKey, id, seq, sealed),
    finish: (id, sealedMeta) => b.finishCallRecording(identityKey, id, sealedMeta),
  }
}

export type OpenedRecording = { meta: RecordingMeta | null; blob: Blob; complete: boolean }

/** A recording unsealed for playback, or null when it is no longer on this device. */
export async function openCallRecording(id: string): Promise<OpenedRecording | null> {
  const b = bridge()
  if (!b) return null
  const { identityKey } = account()
  const read = await b.readCallRecording(identityKey, id)
  if (read.parts.length === 0) return null
  const key = await callRecordingKey(id)
  const meta = read.meta ? await openMeta(key, id, read.meta) : null
  const plain: Uint8Array[] = []
  for (const [at, part] of read.parts.entries()) {
    try {
      plain.push(await openPart(key, id, at, part))
    } catch {
      break
    }
  }
  if (plain.length === 0) return null
  return {
    meta,
    blob: new Blob(plain as BlobPart[], { type: meta?.mime ?? 'video/webm' }),
    complete: !!meta && plain.length === read.parts.length,
  }
}

export async function deleteCallRecording(id: string): Promise<void> {
  const b = bridge()
  if (!b) return
  await b.deleteCallRecording(account().identityKey, id)
}
