import { Transaction, Utils } from '@bsv/sdk'
import { checkLtcBurial, type LtcBurialProof } from '../wltc/verify'
import type { HctBacking } from './payload'

/**
 * BRC-255 backed tokens. A backed deploy (`bk`) and every mint that issues
 * units carry one backing output naming the deposit on the other chain:
 *
 *   OP_FALSE OP_RETURN "hctb" <deposit txid (internal order) || vout u32le> <asset id | OP_0>
 *
 * OP_0 in place of the asset id means "the deploy this transaction writes".
 * Units a backed transaction writes are credited at once, but they move only
 * in a transaction that comes with the deposit's burial proof. The rule is
 * peer to peer: no script enforces it, every reader's walk does.
 */

export type BackingOutpoint = { txid: string; vout: number }
export type HctBackingProof = LtcBurialProof

const PREFIX = '006a0468637462'
const TXID = /^[0-9a-f]{64}$/
const HEX = /^(?:[0-9a-f]{2})*$/
/** Largest deposit transaction a proof may carry, as hex characters. */
const MAX_TX_HEX = 200_000

export function hctBackingScript(deposit: BackingOutpoint, assetId: string | null): string {
  const txid = Utils.toHex(Utils.toArray(deposit.txid, 'hex').reverse())
  const v = deposit.vout >>> 0
  const vout = Utils.toHex([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff])
  return `${PREFIX}24${txid}${vout}${assetId ? `14${assetId}` : '00'}`
}

/** Every backing output of `tx`, with the asset it names (null: the deploy this transaction writes). */
export function readBackingOutputs(tx: Transaction): Array<{ vout: number; deposit: BackingOutpoint; assetId: string | null }> {
  const out: Array<{ vout: number; deposit: BackingOutpoint; assetId: string | null }> = []
  tx.outputs.forEach((o, vout) => {
    const hex = o.lockingScript?.toHex() ?? ''
    if (!hex.startsWith(PREFIX)) return
    const body = hex.slice(PREFIX.length)
    if (body.slice(0, 2) !== '24') return
    const outpoint = body.slice(2, 74)
    const rest = body.slice(74)
    let assetId: string | null
    if (rest === '00') assetId = null
    else if (rest.length === 42 && rest.startsWith('14')) assetId = rest.slice(2)
    else return
    const bytes = Utils.toArray(outpoint, 'hex')
    const txid = Utils.toHex(bytes.slice(0, 32).reverse())
    const vo = (bytes[32]! | (bytes[33]! << 8) | (bytes[34]! << 16) | (bytes[35]! << 24)) >>> 0
    out.push({ vout, deposit: { txid, vout: vo }, assetId })
  })
  return out
}

/** One deposit backs one issuance across every asset sharing a chain and reserve (BRC-212 §1); this names it. */
export function backingDepositKey(bk: HctBacking, deposit: BackingOutpoint): string {
  return `${bk.chain}:${bk.reserve.toLowerCase()}:${deposit.txid.toLowerCase()}:${deposit.vout}`
}

/** The deposit behind `tx` for asset `assetId` whose deploy is `deployTxid`, or null when `tx` names none. */
export function backingDepositOf(tx: Transaction, txid: string, assetId: string, deployTxid: string): BackingOutpoint | null {
  const hits = readBackingOutputs(tx).filter((b) => b.assetId === assetId || (b.assetId === null && txid === deployTxid))
  return hits.length === 1 ? hits[0]!.deposit : null
}

/** How many backing outputs of `tx` name `assetId` (or, in its deploy transaction, the deploy). */
export function backingCount(tx: Transaction, txid: string, assetId: string, deployTxid: string): number {
  return readBackingOutputs(tx).filter((b) => b.assetId === assetId || (b.assetId === null && txid === deployTxid)).length
}

/** Strict read of a proof from a package or a store; null when malformed, or in the header-run form before 1.3.604. */
export function readBackingProof(value: unknown): HctBackingProof | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.tx !== 'string' || !HEX.test(v.tx) || v.tx.length === 0 || v.tx.length > MAX_TX_HEX) return null
  if (!Number.isSafeInteger(v.pos) || (v.pos as number) < 0) return null
  if (!Number.isSafeInteger(v.height) || (v.height as number) <= 0) return null
  if (!Array.isArray(v.path) || v.path.length > 32 || !v.path.every((p) => typeof p === 'string' && TXID.test(p))) return null
  if (typeof v.header !== 'string' || !/^[0-9a-f]{160}$/.test(v.header)) return null
  return { tx: v.tx, path: v.path as string[], pos: v.pos as number, height: v.height as number, header: v.header }
}

/** `missing`: the proof may check later (not deep yet on this wallet's chain, or the chain was unreachable). */
export type BackingCheck = { ok: true } | { ok: false; detail: string; missing: boolean }

/** Check that `proof` buries `deposit` on this wallet's own chain of the backing, paying the reserve at least `minted` units. */
export async function checkBackingProof(bk: HctBacking, proof: HctBackingProof, deposit: BackingOutpoint, minted: bigint): Promise<BackingCheck> {
  if (bk.chain === 'ltc') {
    const check = await checkLtcBurial(proof, deposit, Uint8Array.from(Utils.toArray(bk.reserve, 'hex')), minted)
    return check.ok ? { ok: true } : { ok: false, detail: `${check.reason}: ${check.detail}`, missing: check.missing }
  }
  return { ok: false, detail: `no reader for chain ${String(bk.chain)}`, missing: false }
}
