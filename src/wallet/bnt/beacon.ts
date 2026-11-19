import { MerklePath, Transaction } from '@bsv/sdk'
import { sourceTxidOf } from '../txInputs'
import { MAX_BEACON_CHAIN } from './release'
import { BNT_PACKAGE_BUDGET } from './proof'
import { bntBeaconLock } from './script'
import type { BntDeploy } from './validity'

/**
 * BRC-253 §9 beacon discovery and the bounded transport of a beacon chain.
 * Discovery is pure over two chain queries, so a recipient can run it again
 * after a restart and reach the same verdict. A failed query is `unavailable`,
 * never a verdict: the caller retries later and never caches it as final.
 */

/** Transaction at a txid, or null when the source does not have it. */
export type TxSource = (txid: string) => Promise<Transaction | null>
/** The transaction that spends an outpoint, or null while it is unspent. */
export type SpenderSource = (outpoint: string) => Promise<Transaction | null>

export type BeaconDiscovery =
  | { ok: true; chain: Transaction[] }
  | { ok: false; unavailable: boolean; detail: string }

const OUTPOINT = /^([0-9a-f]{64})_(\d+)$/

/**
 * Follow the beacon from the deploy's `bcn`, spend by spend. The chain ends at
 * the first spend that writes no next beacon at output 0, which is the release
 * or a retirement; an unspent beacon ends it too. The result is judged by
 * `checkIptRelease`, so discovery only collects transactions.
 */
export async function discoverBeaconChain(
  deploy: BntDeploy,
  txOf: TxSource,
  spenderOf: SpenderSource,
): Promise<BeaconDiscovery> {
  const invalid = (detail: string): BeaconDiscovery => ({ ok: false, unavailable: false, detail })
  if (deploy.rules.mode !== 'countersign') return invalid('the asset is not an IPT')
  const bcn = deploy.fields.bcn ?? ''
  const start = OUTPOINT.exec(bcn)
  if (!start) return invalid('the deploy names no beacon')
  const script = bntBeaconLock(deploy.rules).toHex()
  let origin: Transaction | null
  try {
    origin = await txOf(start[1]!)
  } catch {
    return { ok: false, unavailable: true, detail: 'the beacon transaction could not be fetched' }
  }
  if (!origin) return { ok: false, unavailable: true, detail: 'the beacon transaction is not available' }
  if (String(origin.id('hex')).toLowerCase() !== start[1]) return invalid('the beacon transaction does not hash to its txid')
  const chain: Transaction[] = [origin]
  let outpoint = bcn
  let parent = origin
  let vout = Number(start[2])
  for (;;) {
    let spender: Transaction | null
    try {
      spender = await spenderOf(outpoint)
    } catch {
      return { ok: false, unavailable: true, detail: 'the beacon spend could not be fetched' }
    }
    if (!spender) return { ok: true, chain }
    if (chain.length >= MAX_BEACON_CHAIN) return invalid('the beacon chain is too large')
    const parentId = String(parent.id('hex')).toLowerCase()
    const spends = spender.inputs.some((_, vin) => sourceTxidOf(spender, vin) === parentId && spender.inputs[vin]!.sourceOutputIndex === vout)
    if (!spends) return invalid('the source returned a transaction that does not spend the beacon')
    chain.push(spender)
    const next = spender.outputs[0]
    if (!next || next.satoshis !== 1 || next.lockingScript.toHex() !== script) return { ok: true, chain }
    parent = spender
    vout = 0
    outpoint = `${String(spender.id('hex')).toLowerCase()}_0`
  }
}

/**
 * Bounded package for one beacon chain; a chain that does not fit is refused, never cut.
 * `proofs[i]` is the merkle path hex of `chain[i]`, or '' while unproven. EF hex
 * does not carry the proof, so the release proof must travel beside it.
 */
export type BeaconPackage = { v: 1; beacon: string; chain: string[]; proofs: string[] }

export function buildBeaconPackage(
  beacon: string,
  chain: readonly Transaction[],
  budget = BNT_PACKAGE_BUDGET,
): { ok: true; pkg: BeaconPackage } | { ok: false; detail: string } {
  if (!OUTPOINT.test(beacon)) return { ok: false, detail: 'the beacon is not a txid_vout outpoint' }
  if (chain.length === 0 || chain.length > MAX_BEACON_CHAIN) return { ok: false, detail: 'the beacon chain is out of bounds' }
  const ef = chain.map((tx) => tx.toHexEF())
  const proofs = chain.map((tx) => tx.merklePath?.toHex() ?? '')
  const size = ef.reduce((sum, hex) => sum + hex.length + 3, 64 + beacon.length)
    + proofs.reduce((sum, hex) => sum + hex.length + 3, 0)
  if (size > budget) return { ok: false, detail: 'the beacon chain does not fit one package' }
  return { ok: true, pkg: { v: 1, beacon, chain: ef, proofs } }
}

const HEX = /^(?:[0-9a-f]{2})+$/i

/** Strict read of a received beacon package; null when any part is malformed. */
export function readBeaconPackage(value: unknown): { beacon: string; chain: Transaction[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.v !== 1 || typeof v.beacon !== 'string' || !OUTPOINT.test(v.beacon)) return null
  if (!Array.isArray(v.chain) || v.chain.length < 2 || v.chain.length > MAX_BEACON_CHAIN) return null
  if (!Array.isArray(v.proofs) || v.proofs.length !== v.chain.length) return null
  const chain: Transaction[] = []
  for (const [at, hex] of v.chain.entries()) {
    if (typeof hex !== 'string' || !HEX.test(hex)) return null
    const proof = v.proofs[at]
    if (typeof proof !== 'string' || (proof !== '' && !HEX.test(proof))) return null
    try {
      const tx = Transaction.fromHexEF(hex)
      if (proof) tx.merklePath = MerklePath.fromHex(proof)
      chain.push(tx)
    } catch {
      return null
    }
  }
  return { beacon: v.beacon, chain }
}
