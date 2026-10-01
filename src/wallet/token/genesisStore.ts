import { Beef, type ChainTracker } from '@bsv/sdk'
import { base64ToBytes, bytesToBase64 } from '../base64Binary'
import { storageRegistry } from '../../storage/registry'
import { durableGetItem, durableSetItem } from '../durableStorage'

/**
 * Deploy transactions of BSV-21 tokens a held tip was proven back to.
 *
 * The deploy output is the only place an issuer's Sigma lives, so a wallet that
 * proves a received token and drops the deploy can never attest it. Deploys are
 * public chain data and kept device-wide. A merkle proof is kept only once it
 * matched a block header: the deploy's height judges which issuer key was
 * current, so a forged height must never reach issuer attribution.
 */
const STORE_KEY = storageRegistry.tokenGenesis.key
const MAX_ENTRY_CHARS = 96 * 1024
const MAX_TOTAL_CHARS = 1024 * 1024

let store: Map<string, string> | null = null
const parsed = new Map<string, Beef>()

const keyOf = (txid: string): string => txid.trim().toLowerCase()

function load(): Map<string, string> {
  if (store) return store
  store = new Map()
  try {
    const raw = durableGetItem(STORE_KEY)
    const rows = raw ? (JSON.parse(raw) as unknown) : null
    if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
      for (const [txid, b64] of Object.entries(rows as Record<string, unknown>)) {
        if (/^[0-9a-f]{64}$/.test(txid) && typeof b64 === 'string') store.set(txid, b64)
      }
    }
  } catch {
    store.clear()
  }
  return store
}

function save(rows: Map<string, string>): void {
  let total = 0
  for (const b64 of rows.values()) total += b64.length
  for (const [txid, b64] of rows) {
    if (total <= MAX_TOTAL_CHARS) break
    rows.delete(txid)
    parsed.delete(txid)
    total -= b64.length
  }
  durableSetItem(STORE_KEY, JSON.stringify(Object.fromEntries(rows)))
}

/** The retained deploy transaction, or null until a proven tip named it. */
export function retainedTokenGenesis(txid: string): Beef | null {
  const key = keyOf(txid)
  const hit = parsed.get(key)
  if (hit) return hit
  const b64 = load().get(key)
  if (!b64) return null
  try {
    const beef = Beef.fromBinary(Array.from(base64ToBytes(b64)))
    if (!beef.findTxid(key)?.tx) return null
    parsed.set(key, beef)
    return beef
  } catch {
    return null
  }
}

function hasHeaderCheckedProof(txid: string): boolean {
  const beef = retainedTokenGenesis(txid)
  return beef?.findTxid(txid)?.bumpIndex !== undefined
}

/**
 * Keep the deploy body from a package whose walk reached it. Returns whether
 * the store now holds it.
 */
export async function retainTokenGenesis(
  source: Beef,
  deployTxid: string,
  tracker: ChainTracker | null | undefined,
): Promise<boolean> {
  const key = keyOf(deployTxid)
  if (!/^[0-9a-f]{64}$/.test(key)) return false
  const entry = source.findTxid(key)
  if (!entry?.tx) return retainedTokenGenesis(key) != null
  if (hasHeaderCheckedProof(key)) return true
  const path =
    entry.bumpIndex !== undefined ? source.bumps[entry.bumpIndex] : entry.tx.merklePath
  const out = new Beef()
  let bumpIndex: number | undefined
  if (path && tracker) {
    try {
      if (await tracker.isValidRootForHeight(path.computeRoot(key), path.blockHeight)) {
        bumpIndex = out.mergeBump(path)
      }
    } catch {
      bumpIndex = undefined
    }
  }
  if (bumpIndex === undefined && retainedTokenGenesis(key)) return true
  out.mergeRawTx(entry.tx.toBinary(), bumpIndex)
  const b64 = bytesToBase64(out.toBinary())
  if (b64.length > MAX_ENTRY_CHARS) {
    console.warn(`[bsv21] deploy ${key.slice(0, 12)} not retained — ${b64.length} chars over budget`)
    return false
  }
  const rows = load()
  rows.delete(key)
  rows.set(key, b64)
  parsed.delete(key)
  save(rows)
  return true
}

export function resetTokenGenesisForTests(): void {
  store = null
  parsed.clear()
}
