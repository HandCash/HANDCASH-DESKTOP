/**
 * Renderer bridge to the pure-Rust SQLite WAL Wallet Engine (`window.handcash.engine`).
 *
 * Non-destructive Phase 1 integration:
 * - Tracks the active account's `(accountId, generation)` fence on unlock, switch, and lock.
 * - Mirrors BRC-38 exports into SQLite WAL hot tables + SHA-256 cold blobs off the UI thread.
 * - Provides <1ms WAL reads (balance, cursor-paged items & activity) and rate-limited
 *   off-thread source-tx hydration (`hydrateTxidsViaRustEngine`).
 * - Subscribes to coalesced `engine:patch` pushes (<=20Hz, 0Hz when idle).
 */
import { appendAppLog } from './appLog'

export type RustEngineBalance = {
  spendableSats: number
  pendingChangeSats: number
  displayedSats: number
  spendableUtxoCount: number
  itemCount: number
}

export type RustEnginePatch = {
  accountId: string
  generation: number
  seq: number
  dirty: {
    balance: boolean
    items: boolean
    activity: boolean
    sync: boolean
  }
  balance: RustEngineBalance | null
}

type ActiveFence = {
  accountId: string
  generation: number
}

let activeFence: ActiveFence | null = null
let lastMirroredHash = ''
let patchUnsub: (() => void) | null = null
const patchListeners = new Set<(patch: RustEnginePatch) => void>()

function nativeEngine() {
  if (typeof window === 'undefined') return undefined
  return window.handcash?.engine
}

export function isRustEngineAvailable(): boolean {
  return typeof nativeEngine()?.activateAccount === 'function'
}

export function getActiveRustEngineFence(): ActiveFence | null {
  return activeFence
}

function ensurePatchSubscription(): void {
  if (patchUnsub) return
  const engine = nativeEngine()
  if (!engine?.onPatch) return
  patchUnsub = engine.onPatch((patch) => {
    if (!activeFence) return
    if (patch.accountId !== activeFence.accountId || patch.generation !== activeFence.generation) {
      return
    }
    for (const listener of patchListeners) {
      try {
        listener(patch)
      } catch {
        /* listener isolation */
      }
    }
  })
}

export function subscribeRustEnginePatches(listener: (patch: RustEnginePatch) => void): () => void {
  ensurePatchSubscription()
  patchListeners.add(listener)
  return () => {
    patchListeners.delete(listener)
  }
}

/** Activate an account in the Rust SQLite WAL engine, bumping the monotonic generation fence. */
export async function activateRustEngineAccount(accountId: string): Promise<ActiveFence | null> {
  const engine = nativeEngine()
  if (!engine?.activateAccount || !accountId.trim()) return null
  ensurePatchSubscription()
  try {
    const res = await engine.activateAccount(accountId)
    activeFence = { accountId: res.accountId, generation: res.generation }
    lastMirroredHash = ''
    appendAppLog(
      'info',
      `[rust-engine] activated gen=${res.generation} sqlite spendable=${res.balance.spendableSats} items=${res.balance.itemCount}`,
    )
    return activeFence
  } catch (err) {
    appendAppLog(
      'warn',
      `[rust-engine] activate skipped — ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/** Deactivate the current account runtime in Rust when locking the wallet. */
export async function lockRustEngine(): Promise<void> {
  activeFence = null
  lastMirroredHash = ''
  const engine = nativeEngine()
  if (!engine?.lock) return
  try {
    await engine.lock()
  } catch {
    /* ignore on shutdown */
  }
}

/** Non-destructively mirror a BRC-38 export into Rust's SQLite WAL hot/cold store off-thread. */
export async function mirrorBrc38ToRustEngine(json: string): Promise<void> {
  const engine = nativeEngine()
  const fence = activeFence
  if (!engine?.importBrc38 || !fence || !json) return
  const fingerprint = `${fence.accountId}:${fence.generation}:${json.length}:${json.slice(0, 64)}:${json.slice(-64)}`
  if (fingerprint === lastMirroredHash) return
  try {
    const started = Date.now()
    const stats = await engine.importBrc38(fence.accountId, fence.generation, json)
    lastMirroredHash = fingerprint
    appendAppLog(
      'info',
      `[rust-engine] sqlite mirror done ${Date.now() - started}ms txs=${stats.transactions} utxos=${stats.utxos} items=${stats.items} blobs=${stats.blobsWritten} skippedProofReqs=${stats.skippedRetiredProofReqs}`,
    )
  } catch (err) {
    appendAppLog(
      'warn',
      `[rust-engine] sqlite mirror skipped — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

/**
 * Hydrate cold source transactions through Rust's per-host rate-limited, singleflight
 * ChainFetcher + SQLite cold blob store (completely off the UI thread).
 */
export async function hydrateTxidsViaRustEngine(
  txids: string[],
  allowRaw = false,
): Promise<Map<string, { kind: 'beef' | 'raw_tx'; bytes: Uint8Array }>> {
  const out = new Map<string, { kind: 'beef' | 'raw_tx'; bytes: Uint8Array }>()
  const engine = nativeEngine()
  const fence = activeFence
  if (!engine?.hydrateInputs || !fence || txids.length === 0) return out
  try {
    const res = await engine.hydrateInputs({
      accountId: fence.accountId,
      generation: fence.generation,
      txids,
      allowRaw,
    })
    for (const [txid, entry] of Object.entries(res.found ?? {})) {
      if (!entry?.bytesBase64) continue
      out.set(txid.toLowerCase(), {
        kind: entry.kind === 'raw_tx' ? 'raw_tx' : 'beef',
        bytes: base64ToUint8Array(entry.bytesBase64),
      })
    }
  } catch (err) {
    appendAppLog(
      'warn',
      `[rust-engine] hydrate inputs fallback — ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return out
}

export type RustBrc150Verdict =
  | {
      status: 'proven'
      originOutpoint: string
      tipOutpoint: string
      path: string[]
      contentType: string
      name?: string | null
      issuer?: string | null
    }
  | {
      status: 'unproven'
      reason: string
      missingTxid?: string | null
    }

/** Verify a BEEF/AtomicBEEF payload using Rust SPV + PoW-verified headers off the UI thread. */
export async function verifyBeefViaRustEngine(
  beefBytes: Uint8Array,
  subjectTxid?: string,
): Promise<{
  valid: boolean
  subjectTxid: string | null
  txCount: number
  bumpCount: number
  error: string | null
} | null> {
  const engine = nativeEngine()
  const fence = activeFence
  if (!engine?.verifyBeef || !fence) return null
  try {
    return await engine.verifyBeef({
      accountId: fence.accountId,
      generation: fence.generation,
      beefBytes,
      ...(subjectTxid ? { subjectTxid } : {}),
    })
  } catch (err) {
    appendAppLog(
      'warn',
      `[rust-engine] verifyBeef fallback — ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/** Run BRC-150 tip -> origin verification completely off the UI thread in Rust. */
export async function verifyBrc150ViaRustEngine(
  tipOutpoint: string,
  opts?: { expectedOrigin?: string; beefBytes?: Uint8Array; beefBase64?: string },
): Promise<RustBrc150Verdict | null> {
  const engine = nativeEngine()
  const fence = activeFence
  if (!engine?.verifyBrc150 || !fence) return null
  try {
    return await engine.verifyBrc150({
      accountId: fence.accountId,
      generation: fence.generation,
      tipOutpoint,
      ...(opts?.expectedOrigin ? { expectedOrigin: opts.expectedOrigin } : {}),
      ...(opts?.beefBytes ? { beefBytes: opts.beefBytes } : {}),
      ...(opts?.beefBase64 ? { beefBase64: opts.beefBase64 } : {}),
    })
  } catch (err) {
    appendAppLog(
      'warn',
      `[rust-engine] verifyBrc150 fallback — ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/** Trigger one Lane 2 Rust header + proof + outbox pass on demand. */
export async function runRustProofPoll(): Promise<{
  tipHeight: number | null
  broadcastsAccepted: number
  proofsSettled: number
} | null> {
  const engine = nativeEngine()
  const fence = activeFence
  if (!engine?.runProofPoll || !fence) return null
  try {
    return await engine.runProofPoll(fence.accountId, fence.generation)
  } catch {
    return null
  }
}

/** Seal pending append-only facts into an immutable tamper-evident delta segment in Rust. */
export async function sealRustDeltaSegment(): Promise<{
  segmentId: string
  rootHash: string
  factCount: number
} | null> {
  const engine = nativeEngine()
  const fence = activeFence
  if (!engine?.sealDeltaSegment || !fence) return null
  try {
    return await engine.sealDeltaSegment(fence.accountId, fence.generation)
  } catch {
    return null
  }
}

export function resetRustEngineBridgeForTests(): void {
  activeFence = null
  lastMirroredHash = ''
  if (patchUnsub) {
    patchUnsub()
    patchUnsub = null
  }
  patchListeners.clear()
}
