import { getActiveWallet } from './session'

/**
 * Durable copy of wallet-managed BRC-29 change remittance.
 *
 * Toolbox rows hold `derivationPrefix` / `derivationSuffix`. Those live in
 * IndexedDB and vanish on a BRC-39 restore from an older snapshot, while the
 * coins stay on chain at the derived P2PKH addresses. Overlay seals survive in
 * `durable-prefs`, so reclaim can see the outpoint, confirm it unspent, and
 * still have nothing to spend with.
 *
 * This echo is the missing piece: same durable store as the overlay, written
 * whenever we still have the toolbox row (sweep, keep-change, backfill).
 * Re-import uses it as wallet-payment remittance — it does not invent a
 * second sweep.
 */
import { Utils } from '@bsv/sdk'
import { durableGetItem, durableSetItem } from './durableStorage'
import { accountLocalKey } from './accountLocalKeys'
import { storageRegistry } from '../storage/registry'
import { parseOutpoint } from './legacyScan'
import { type ActiveWallet } from './session'
import { normalizeOutpointKey } from './txLifecycle'

const STORAGE_KEY_BASE = storageRegistry.derivedChangeEcho.key
function storageKey(): string {
  return accountLocalKey(STORAGE_KEY_BASE)
}

const MAX_ENTRIES = 2000

export type DerivedChangeEcho = {
  txid: string
  vout: number
  satoshis: number
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey?: string
  lockingScriptHex?: string
}

export type DerivedChangeRow = {
  txid?: string
  vout?: number
  outputIndex?: number
  satoshis?: number
  derivationPrefix?: string
  derivationSuffix?: string
  senderIdentityKey?: string
  lockingScript?: unknown
  change?: boolean
  purpose?: string
}

type EchoFile = Record<string, DerivedChangeEcho>

let cachedSig: string | null = null
let cached = new Map<string, DerivedChangeEcho>()

function canonicalOutpoint(txid: string, vout: number): string {
  return `${txid}.${vout}`
}

function echoKey(outpoint: string): string | null {
  const parsed = parseOutpoint(outpoint)
  if (!parsed) return null
  return canonicalOutpoint(parsed.txid, parsed.vout)
}

function lockingScriptHex(script: unknown): string | undefined {
  if (typeof script === 'string') {
    const hex = script.trim().toLowerCase()
    return /^[0-9a-f]+$/.test(hex) && hex.length > 0 ? hex : undefined
  }
  if (script instanceof Uint8Array && script.length > 0) {
    return Utils.toHex(Array.from(script))
  }
  if (Array.isArray(script) && script.length > 0 && script.every((n) => typeof n === 'number')) {
    return Utils.toHex(script as number[])
  }
  return undefined
}

export function derivedChangeEchoFromRow(row: DerivedChangeRow): DerivedChangeEcho | null {
  const prefix = String(row.derivationPrefix ?? '').trim()
  const suffix = String(row.derivationSuffix ?? '').trim()
  if (!prefix || !suffix) return null
  const parsedTx = String(row.txid ?? '')
    .trim()
    .toLowerCase()
  const vout = Number(row.vout ?? row.outputIndex)
  if (!/^[0-9a-f]{64}$/.test(parsedTx) || !Number.isInteger(vout) || vout < 0) {
    return null
  }
  const satoshis = Math.max(0, Math.trunc(Number(row.satoshis) || 0))
  const sender = String(row.senderIdentityKey ?? '').trim()
  const locking = lockingScriptHex(row.lockingScript)
  return {
    txid: parsedTx,
    vout,
    satoshis,
    derivationPrefix: prefix,
    derivationSuffix: suffix,
    ...(sender ? { senderIdentityKey: sender } : {}),
    ...(locking ? { lockingScriptHex: locking } : {}),
  }
}

function readEcho(): Map<string, DerivedChangeEcho> {
  const raw = durableGetItem(storageKey()) ?? ''
  if (raw === cachedSig) return cached
  const next = new Map<string, DerivedChangeEcho>()
  try {
    const parsed = JSON.parse(raw) as EchoFile
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        const echo = derivedChangeEchoFromRow(value)
        if (!echo) continue
        next.set(echoKey(key) ?? canonicalOutpoint(echo.txid, echo.vout), echo)
      }
    }
  } catch {
    /* empty */
  }
  cachedSig = raw
  cached = next
  return next
}

function writeEcho(map: Map<string, DerivedChangeEcho>): void {
  const trimmed = [...map.entries()]
    .sort((a, b) => a[1].satoshis - b[1].satoshis)
    .slice(-MAX_ENTRIES)
  const body = JSON.stringify(Object.fromEntries(trimmed))
  durableSetItem(storageKey(), body)
  cachedSig = body
  cached = new Map(trimmed)
}

export function rememberDerivedChange(echoes: DerivedChangeEcho[]): number {
  if (echoes.length === 0) return 0
  const known = new Map(readEcho())
  let added = 0
  for (const echo of echoes) {
    const valid = derivedChangeEchoFromRow(echo)
    if (!valid) continue
    const key = canonicalOutpoint(valid.txid, valid.vout)
    const prev = known.get(key)
    if (
      prev &&
      prev.derivationPrefix === valid.derivationPrefix &&
      prev.derivationSuffix === valid.derivationSuffix &&
      prev.satoshis === valid.satoshis
    ) {
      continue
    }
    known.set(key, valid)
    added += 1
  }
  if (added > 0) writeEcho(known)
  return added
}

export function rememberDerivedChangeFromRows(rows: DerivedChangeRow[]): number {
  return rememberDerivedChange(
    rows.map(derivedChangeEchoFromRow).filter((row): row is DerivedChangeEcho => row != null),
  )
}

export function derivedChangeEchoFor(outpoint: string): DerivedChangeEcho | null {
  const key = echoKey(outpoint)
  if (!key) return null
  return readEcho().get(key) ?? null
}

export function listDerivedChangeEcho(): DerivedChangeEcho[] {
  return [...readEcho().values()]
}

export function rebindDerivedChangeEchoForAccount(): void {
  cachedSig = null
  cached = new Map()
}

/** Overlay keys (`txid_vout`) that have remittance we can re-import with. */
export function derivedChangeEchoLockKeys(): Set<string> {
  const keys = new Set<string>()
  for (const echo of readEcho().values()) {
    keys.add(normalizeOutpointKey(`${echo.txid}.${echo.vout}`))
  }
  return keys
}

export function derivedChangeEchoSatoshis(outpoint: string): number {
  return derivedChangeEchoFor(outpoint)?.satoshis ?? 0
}

type OutputLookup = {
  findOutputs?: (args: unknown) => Promise<unknown>
  findTransactions?: (args: unknown) => Promise<Array<{ transactionId?: number }> | undefined>
}

async function rowsForTxid(sp: OutputLookup, txid: string): Promise<DerivedChangeRow[]> {
  if (typeof sp.findOutputs !== 'function') return []
  const direct = await sp.findOutputs({
    partial: { txid },
    paged: { limit: 50, offset: 0 },
  })
  const rows = Array.isArray(direct) ? (direct as DerivedChangeRow[]) : []
  if (rows.length > 0 || typeof sp.findTransactions !== 'function') return rows
  const txRows = await sp.findTransactions({
    partial: { txid },
    noRawTx: true,
    paged: { limit: 1, offset: 0 },
  })
  const transactionId = Number(txRows?.[0]?.transactionId)
  if (!Number.isFinite(transactionId) || transactionId <= 0) return rows
  const linked = await sp.findOutputs({
    partial: { transactionId },
    paged: { limit: 50, offset: 0 },
  })
  if (!Array.isArray(linked)) return rows
  return (linked as DerivedChangeRow[]).map((row) => ({ ...row, txid }))
}

/** Snapshot toolbox change remittance for a tx we just created or restored. */
export async function rememberDerivedChangeFromTxid(
  txid: string,
  active?: ActiveWallet | null,
): Promise<number> {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return 0
  const wallet = active ?? getActiveWallet()
  const storage = wallet?.wallet?.storage
  if (!storage?.runAsStorageProvider) return 0
  try {
    const rows = (await storage.runAsStorageProvider(async (sp) =>
      rowsForTxid(sp as OutputLookup, id),
    )) as DerivedChangeRow[]
    return rememberDerivedChangeFromRows(rows)
  } catch (err) {
    console.warn('[derived-change] echo snapshot skipped', id.slice(0, 12), err)
    return 0
  }
}

/** Test-only */
export function resetDerivedChangeEchoForTests(): void {
  cachedSig = null
  cached = new Map()
  durableSetItem(storageKey(), '{}')
}
