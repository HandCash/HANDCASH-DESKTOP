/**
 * Prevents the same legacy P2PKH outpoint from being swept more than once.
 *
 * fundWalletFromP2PKHOutpoints can succeed locally before WhatsOnChain drops the
 * UTXO from /unspent. A second sync would otherwise import it again and 2–3× the
 * balance for a single external payment.
 */
import { durableGetItem, durableSetItem } from './durableStorage'

const STORAGE_KEY = 'handcash.brc100.importedLegacyOutpoints'
const MAX_TRACKED = 2000

const memory = new Set<string>()
const inFlight = new Set<string>()
let loaded = false

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = durableGetItem(STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return
    for (const op of parsed) {
      if (typeof op === 'string' && op.includes('.')) memory.add(op)
    }
  } catch {
    // ignore corrupt cache
  }
}

function persist(): void {
  load()
  let list = [...memory]
  if (list.length > MAX_TRACKED) list = list.slice(list.length - MAX_TRACKED)
  durableSetItem(STORAGE_KEY, JSON.stringify(list))
}

export function wasLegacyOutpointImported(outpoint: string): boolean {
  load()
  return memory.has(outpoint) || inFlight.has(outpoint)
}

/** Claim outpoints for import. Returns only those not already imported/in-flight. */
export function claimLegacyOutpoints(outpoints: string[]): string[] {
  load()
  const claimed: string[] = []
  for (const op of outpoints) {
    if (memory.has(op) || inFlight.has(op)) continue
    inFlight.add(op)
    claimed.push(op)
  }
  return claimed
}

export function markLegacyOutpointImported(outpoint: string): void {
  load()
  inFlight.delete(outpoint)
  if (memory.has(outpoint)) return
  memory.add(outpoint)
  persist()
}

export function releaseLegacyOutpointClaim(outpoint: string): void {
  inFlight.delete(outpoint)
}
