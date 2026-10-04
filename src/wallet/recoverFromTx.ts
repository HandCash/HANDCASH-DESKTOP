/**
 * Recover from a transaction: claim the token and item tips in one txid that
 * pay this wallet's address.
 *
 * No public index finds an unspent BRC-162 tip by owner — the value prefix
 * hides the P2PKH from WhatsOnChain, Bitails, JungleBus and the GorillaPool
 * ordinal index alike — so an install whose history backup never held a
 * received token cannot rediscover it from keys. The sender's txid can: every
 * 1-sat output of that transaction locked to `active.address` and proven
 * unspent goes through the same classification and import as chain ingest —
 * except that, with no index behind the claim, a token tip must walk BRC-176
 * to its deploy before it is filed.
 */
import { Transaction } from '@bsv/sdk'
import { scriptPaysAddress } from './ordinalOwnership'
import { getActiveWallet } from './session'
import { classifyLegacyUtxos, fetchRawTxHex, importOneSatOrdinals } from './oneSatImport'
import { outpointProvenUnspent } from './staleOutputRelease'
import type { LegacyUtxo } from './legacyScan'

export type RecoverFromTxResult = Readonly<{
  /** 1-sat outputs of the transaction locked to this wallet. */
  ours: number
  /** Of those, not proven unspent — spent, or the explorers did not answer. */
  spent: number
  tokens: number
  items: number
  /** Ours, unspent, and neither a token nor an item this wallet can name. */
  unrecognized: number
  /** Named tokens / items the import guard passed over: already imported, in flight, or backing off. */
  skipped: number
}>

const TXID_RE = /^[0-9a-f]{64}$/

export function parseRecoverTxid(raw: string): string {
  const txid = raw.trim().toLowerCase()
  if (!TXID_RE.test(txid)) throw new Error('Enter a 64-character transaction id.')
  return txid
}

export async function recoverFromTx(
  rawTxid: string,
  opts: {
    only?: ReadonlySet<string>
    /** Outpoints the caller just proved unspent on chain; not asked again. */
    provenUnspent?: ReadonlySet<string>
  } = {},
): Promise<RecoverFromTxResult> {
  const txid = parseRecoverTxid(rawTxid)
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock the wallet first.')

  const hex = await fetchRawTxHex(txid, active.chain, { pinMiss: false })
  if (!hex) throw new Error('Transaction not found on chain.')
  const tx = Transaction.fromHex(hex)

  const ours: LegacyUtxo[] = []
  tx.outputs.forEach((out, vout) => {
    if (out.satoshis !== 1) return
    if (!scriptPaysAddress(out.lockingScript.toHex(), active.address)) return
    if (opts.only && !opts.only.has(`${txid}.${vout}`)) return
    ours.push({ outpoint: `${txid}.${vout}`, txid, vout, satoshis: 1 })
  })

  const live: LegacyUtxo[] = []
  for (const u of ours) {
    if (opts.provenUnspent?.has(u.outpoint) || (await outpointProvenUnspent(active, u.outpoint))) {
      live.push(u)
    }
  }

  const { bsv21, oneSats, heldOneSats } = await classifyLegacyUtxos(live, active.chain)
  let tokens = 0
  let items = 0
  if (bsv21.length > 0) {
    const { importBsv21Tokens, listFungibles } = await import('./token/list')
    const result = await importBsv21Tokens(bsv21, active, { requireLineage: true })
    if (result.failed > 0) throw new Error(result.errors[0] ?? 'Token import failed.')
    tokens = result.imported
    void listFungibles().catch(() => {})
  }
  if (oneSats.length > 0) {
    const result = await importOneSatOrdinals(oneSats, active)
    if (result.failed > 0) throw new Error(result.errors[0] ?? 'Item import failed.')
    items = result.imported
  }

  const outcome: RecoverFromTxResult = {
    ours: ours.length,
    spent: ours.length - live.length,
    tokens,
    items,
    unrecognized: heldOneSats.length,
    skipped: bsv21.length - tokens + (oneSats.length - items),
  }
  console.info(
    `[recover-tx] ${txid.slice(0, 12)} ours=${outcome.ours} spent=${outcome.spent} tokens=${tokens} items=${items} unrecognized=${outcome.unrecognized} skipped=${outcome.skipped}`,
  )
  return outcome
}
