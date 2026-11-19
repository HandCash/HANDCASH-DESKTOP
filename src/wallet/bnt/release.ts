import { OP, PrivateKey, Script, type ChainTracker, type LockingScript, type Transaction } from '@bsv/sdk'
import { inputScriptValid, sourceOutputOf, sourceTxidOf } from '../txInputs'
import { BNT_ISSUER_SCOPE, bntBeaconLock } from './script'
import { outpointBytes } from './payload'
import type { BntDeploy } from './validity'

/** Beacon chain length a recipient follows; more is refused, never walked. */
export const MAX_BEACON_CHAIN = 5_000
const RELEASE_MARKER = [0x69, 0x70, 0x74, 0x20, 0x72, 0x65, 0x6c, 0x65, 0x61, 0x73, 0x65] // "ipt release"

export type IptReleaseCheck =
  | { ok: true; secret: number[] }
  | { ok: true; keys: string[] }
  | { ok: false; missing: boolean; detail: string }

/**
 * Chunks of an output script. A parsed `OP_RETURN` carries the rest of the script
 * as one raw blob, so that blob is parsed into its pushes to match a built script.
 */
function outputChunks(script: LockingScript): LockingScript['chunks'] {
  const chunks = script.chunks
  const at = chunks.findIndex((chunk) => chunk.op === OP.OP_RETURN)
  if (at < 0) return chunks
  const blob = chunks[at]!.data
  const tail = blob ? Script.fromBinary(blob).chunks : chunks.slice(at + 1)
  return [...chunks.slice(0, at + 1), ...tail]
}

/**
 * Public keys of the key-set members a release disclosed, or null when fewer
 * than `k` valid disclosures name this beacon. A disclosure that fails the set
 * check is ignored, not an error (BRC-253 §9): a bad key cannot unlock anything.
 */
export function disclosedReleaseKeys(
  release: Transaction,
  beacon: string,
  set: { k: number; keys: readonly string[] },
): string[] | null {
  const outpoint = outpointBytes(beacon)
  const members = new Set(set.keys.map((key) => key.toLowerCase()))
  const found = new Set<string>()
  for (const output of release.outputs) {
    const chunks = outputChunks(output.lockingScript)
    if (chunks.length < 4 || chunks[0]?.op !== OP.OP_0 || chunks[1]?.op !== OP.OP_RETURN) continue
    const marker = chunks[2]?.data
    if (!marker || marker.length !== RELEASE_MARKER.length || marker.some((byte, at) => byte !== RELEASE_MARKER[at])) continue
    const named = chunks[3]?.data
    if (!named || named.length !== outpoint.length || named.some((byte, at) => byte !== outpoint[at])) continue
    for (const chunk of chunks.slice(4)) {
      const data = chunk.data
      if (!data || data.length !== 32) continue
      let key: string
      try {
        const hex = data.map((byte) => byte.toString(16).padStart(2, '0')).join('')
        key = new PrivateKey(hex, 'hex', 'be', 'error').toPublicKey().toString().toLowerCase()
      } catch {
        continue
      }
      if (members.has(key)) found.add(key)
    }
  }
  return found.size >= set.k ? [...found] : null
}

/**
 * BRC-253 §9, §11.6: verify a beacon chain from the deploy's first beacon
 * through its mined release, for either release form. EF claims are compared
 * with real parents. A release counts only once its tracker-verified proof
 * is mined; a key-set release counts only with k valid disclosures.
 */
export async function checkIptRelease(
  deploy: BntDeploy,
  chain: readonly Transaction[],
  tracker: ChainTracker,
): Promise<IptReleaseCheck> {
  const invalid = (detail: string): IptReleaseCheck => ({ ok: false, missing: false, detail })
  const missing = (detail: string): IptReleaseCheck => ({ ok: false, missing: true, detail })
  if (deploy.rules.mode !== 'countersign') return invalid('the asset is not an IPT')
  if (chain.length < 2) return missing('the beacon chain is incomplete')
  if (chain.length > MAX_BEACON_CHAIN) return invalid('the beacon chain is too large')
  const beacon = deploy.fields.bcn ?? ''
  const first = /^([0-9a-f]{64})_(\d+)$/.exec(beacon)
  if (!first) return invalid('the deploy names no beacon')
  let parent = chain[0]!
  let vout = Number(first[2])
  if (String(parent.id('hex')).toLowerCase() !== first[1]) return invalid('the chain starts at another beacon')
  const script = bntBeaconLock(deploy.rules).toHex()
  for (let index = 1; index < chain.length; index++) {
    const previous = parent.outputs[vout]
    if (!previous || previous.satoshis !== 1 || previous.lockingScript.toHex() !== script) {
      return invalid('the beacon does not match the deploy')
    }
    const tx = chain[index]!
    const parentId = String(parent.id('hex')).toLowerCase()
    const inputs = tx.inputs.flatMap((input, vin) =>
      sourceTxidOf(tx, vin) === parentId && input.sourceOutputIndex === vout ? [vin] : [])
    if (inputs.length !== 1) return invalid('the chain does not spend its preceding beacon exactly once')
    const vin = inputs[0]!
    const claimed = sourceOutputOf(tx, vin)
    if (!claimed || claimed.satoshis !== 1 || claimed.lockingScript.toHex() !== script || !inputScriptValid(tx, vin)) {
      return invalid('the beacon spend does not unlock its real parent')
    }
    const chunks = tx.inputs[vin]!.unlockingScript!.chunks
    const branch = chunks[chunks.length - 1]
    const next = tx.outputs.flatMap((output, at) => output.lockingScript.toHex() === script ? [at] : [])
    if (branch?.data?.length) return invalid('the beacon branch is not canonical')
    if (branch?.op === OP.OP_0) {
      if (index !== chain.length - 1 || next.length !== 0) return invalid('the release continues the beacon chain')
      const rel = deploy.rules.release
      if (rel.kind === 'hash') {
        if (chunks.length !== 2 || chunks[0]?.data?.length !== 32) return invalid('the release secret is not canonical')
      } else {
        const sigs = chunks.slice(1, -1)
        if (chunks.length < 3 || chunks[0]?.op !== OP.OP_0 || chunks[0]?.data?.length ||
          sigs.length !== rel.k || sigs.some((chunk) => !chunk.data?.length)) {
          return invalid('the key-set release is not k signatures')
        }
      }
      const path = tx.merklePath
      if (!path || !Number.isSafeInteger(path.blockHeight) || path.blockHeight <= 0) return missing('the beacon release is not proven mined')
      try {
        if (await path.verify(String(tx.id('hex')), tracker) !== true) return missing('the beacon release is not proven on this chain')
      } catch {
        return missing('the beacon release proof could not be checked')
      }
      if (rel.kind === 'hash') return { ok: true, secret: [...chunks[0]!.data!] }
      // The disclosure names the beacon this release spends (the spec's "beacon outpoint",
      // read the same way as the beacon-sign message's "beacon").
      const keys = disclosedReleaseKeys(tx, `${parentId}_${vout}`, rel)
      if (!keys) return invalid('fewer than k key-set disclosures match the release set')
      return { ok: true, keys }
    }
    if (branch?.op !== OP.OP_1) return invalid('the beacon branch is not canonical')
    const shared = deploy.rules.issuer.keys.length > 1
    const signatures = chunks.slice(shared ? 1 : 0, -1)
    if ((shared && (chunks[0]?.op !== OP.OP_0 || chunks[0]?.data?.length)) ||
      signatures.length !== deploy.rules.issuer.m ||
      signatures.some((chunk) => !chunk.data?.length || chunk.data[chunk.data.length - 1] !== BNT_ISSUER_SCOPE)) {
      return invalid('the beacon refresh is not signed ALL|FORKID')
    }
    if (next.length !== 1 || next[0] !== 0 || tx.outputs[0]!.satoshis !== 1) {
      return invalid('the refresh does not write exactly one next beacon at output 0')
    }
    parent = tx
    vout = 0
  }
  return missing('the beacon has no release spend')
}

/**
 * BRC-253 §11.6 for hash releases: the secret proves the release only once
 * its spend is mined. Kept for callers that only accept the hash form.
 */
export async function checkIptHashRelease(
  deploy: BntDeploy,
  chain: readonly Transaction[],
  tracker: ChainTracker,
): Promise<IptReleaseCheck> {
  if (deploy.rules.mode === 'countersign' && deploy.rules.release.kind !== 'hash') {
    return { ok: false, missing: false, detail: 'the asset releases by key set, not by hash' }
  }
  return checkIptRelease(deploy, chain, tracker)
}
