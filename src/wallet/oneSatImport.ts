/**
 * Import 1Sat ordinals into BRC-100 basket `1sat` via internalizeAction.
 *
 * HARD RULE: never pass satoshis === 1 through fundWalletFromP2PKHOutpoints.
 * Unrecognized 1-sat outs stay on the address until classified (cloud items or GorillaPool).
 */
import type { ActiveWallet } from './session'
import { getActiveWallet } from './session'
import type { Chain } from './vault'
import type { LegacyUtxo } from './legacyScan'

export type MigrationItem = {
  /** Transfer outpoint on the Desktop destination tx: `txid.vout` */
  outpoint: string
  /** Inscription origin, e.g. `txid_vout` (HandCash / OrdFS form) */
  origin?: string
  txid?: string
  vout?: number
}

export type OneSatImportResult = {
  imported: number
  failed: number
  errors: string[]
  outpoints: string[]
}

export type ClassifiedLegacyUtxos = {
  /** satoshis > 1 only — safe to fund-sweep */
  funding: LegacyUtxo[]
  /** Confirmed ordinals — internalize to basket `1sat` */
  oneSats: MigrationItem[]
  /** satoshis === 1, not yet confirmed — leave untouched (never sweep) */
  heldOneSats: LegacyUtxo[]
}

function gorillaBase(chain: Chain): string {
  return chain === 'main'
    ? 'https://ordinals.gorillapool.io'
    : 'https://testnet.ordinals.gorillapool.io'
}

function parseOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const dot = outpoint.lastIndexOf('.')
  if (dot <= 0) return null
  const txid = outpoint.slice(0, dot)
  const vout = Number(outpoint.slice(dot + 1))
  if (!txid || !Number.isInteger(vout) || vout < 0) return null
  return { txid, vout }
}

/** Normalize cloud/item payload into outpoint + origin. */
export function normalizeMigrationItem(raw: unknown): MigrationItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  let txid = typeof o.txid === 'string' ? o.txid : undefined
  let vout = typeof o.vout === 'number' ? o.vout : undefined
  let outpoint = typeof o.outpoint === 'string' ? o.outpoint : undefined
  const origin = typeof o.origin === 'string' ? o.origin : undefined

  if (!outpoint && txid != null && vout != null) {
    outpoint = `${txid}.${vout}`
  }
  if ((!txid || vout == null) && outpoint) {
    const parsed = parseOutpoint(outpoint)
    if (parsed) {
      txid = parsed.txid
      vout = parsed.vout
    }
  }
  if (!outpoint || txid == null || vout == null) return null
  return { outpoint, origin, txid, vout }
}

/** Probe GorillaPool — true if this outpoint is a known inscription. */
export async function isOneSatInscription(
  txid: string,
  vout: number,
  chain: Chain,
): Promise<boolean> {
  try {
    const url = `${gorillaBase(chain)}/api/inscriptions/${txid}_${vout}?script=false`
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Split scanned UTXOs.
 * - funding: only satoshis > 1
 * - oneSats: cloud-known or GorillaPool-confirmed inscriptions
 * - heldOneSats: every other 1-sat — MUST NOT be swept
 */
export async function classifyLegacyUtxos(
  utxos: LegacyUtxo[],
  chain: Chain,
  knownItems: MigrationItem[] = [],
): Promise<ClassifiedLegacyUtxos> {
  const knownByOutpoint = new Map<string, MigrationItem>()
  for (const item of knownItems) {
    const n = normalizeMigrationItem(item)
    if (n) knownByOutpoint.set(n.outpoint, n)
  }

  const funding: LegacyUtxo[] = []
  const oneSats: MigrationItem[] = [...knownByOutpoint.values()]
  const heldOneSats: LegacyUtxo[] = []
  const claimed = new Set(knownByOutpoint.keys())

  for (const u of utxos) {
    if (claimed.has(u.outpoint)) continue

    // HARD RULE: never fund-sweep 1-sat outs.
    if (u.satoshis === 1) {
      const isInsc = await isOneSatInscription(u.txid, u.vout, chain)
      if (isInsc || knownByOutpoint.has(u.outpoint)) {
        oneSats.push({
          outpoint: u.outpoint,
          txid: u.txid,
          vout: u.vout,
          origin: knownByOutpoint.get(u.outpoint)?.origin ?? `${u.txid}_${u.vout}`,
        })
        claimed.add(u.outpoint)
      } else {
        heldOneSats.push(u)
      }
      continue
    }

    if (u.satoshis > 1) {
      funding.push(u)
    }
    // satoshis === 0 or weird values: ignore (do not sweep)
  }

  return { funding, oneSats, heldOneSats }
}

/** Internalize ordinal outs into basket `1sat`. */
export async function importOneSatOrdinals(
  items: MigrationItem[],
  active?: ActiveWallet | null,
): Promise<OneSatImportResult> {
  const wallet = active ?? getActiveWallet()
  if (!wallet) throw new Error('Wallet locked')

  const normalized = items
    .map(normalizeMigrationItem)
    .filter((x): x is MigrationItem => x != null)

  if (normalized.length === 0) {
    return { imported: 0, failed: 0, errors: [], outpoints: [] }
  }

  const byTxid = new Map<string, MigrationItem[]>()
  for (const item of normalized) {
    const txid = item.txid!
    const list = byTxid.get(txid) ?? []
    list.push(item)
    byTxid.set(txid, list)
  }

  let imported = 0
  let failed = 0
  const errors: string[] = []
  const outpoints: string[] = []

  for (const [txid, group] of byTxid) {
    try {
      if (!wallet.services?.getBeefForTxid) {
        throw new Error('Wallet services unavailable for BEEF fetch')
      }
      const beef = await wallet.services.getBeefForTxid(txid)
      const atomic = beef.toBinaryAtomic(txid)

      await wallet.wallet.internalizeAction({
        tx: atomic,
        description: 'Import 1Sat ordinal',
        labels: ['1sat', 'migration'],
        outputs: group.map((item) => ({
          outputIndex: item.vout!,
          protocol: 'basket insertion' as const,
          insertionRemittance: {
            basket: '1sat',
            tags: [
              'ordinal',
              `origin:${(item.origin ?? item.outpoint).replace(/_(\d+)$/, '.$1')}`,
            ],
            customInstructions: item.origin
              ? JSON.stringify({ origin: item.origin })
              : undefined,
          },
        })),
        seekPermission: false,
      })

      imported += group.length
      outpoints.push(...group.map((g) => g.outpoint))
    } catch (err) {
      failed += group.length
      const msg = err instanceof Error ? err.message : String(err)
      for (const item of group) {
        errors.push(`${item.outpoint}: ${msg}`)
      }
      console.warn('[1sat] internalize failed', txid, err)
    }
  }

  return { imported, failed, errors, outpoints }
}
