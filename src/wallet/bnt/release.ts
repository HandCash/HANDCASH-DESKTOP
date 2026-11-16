import { OP, type ChainTracker, type Transaction } from '@bsv/sdk'
import { inputScriptValid, sourceOutputOf, sourceTxidOf } from '../txInputs'
import { BNT_ISSUER_SCOPE, bntBeaconLock } from './script'
import type { BntDeploy } from './validity'

export type IptReleaseCheck =
  | { ok: true; secret: number[] }
  | { ok: false; missing: boolean; detail: string }

/**
 * BRC-253 §9, §11.6: verify a hash-release chain from the deploy's first
 * beacon through its mined release. EF claims are compared with real parents.
 * Key-set disclosure needs its own reader; it is never accepted as a hash release.
 */
export async function checkIptHashRelease(
  deploy: BntDeploy,
  chain: readonly Transaction[],
  tracker: ChainTracker,
): Promise<IptReleaseCheck> {
  const invalid = (detail: string): IptReleaseCheck => ({ ok: false, missing: false, detail })
  const missing = (detail: string): IptReleaseCheck => ({ ok: false, missing: true, detail })
  if (deploy.rules.mode !== 'countersign') return invalid('the asset is not an IPT')
  if (deploy.rules.release.kind !== 'hash') return missing('the key-set release disclosure reader is not available')
  if (chain.length < 2) return missing('the beacon chain is incomplete')
  if (chain.length > 5_000) return invalid('the beacon chain is too large')
  const first = /^([0-9a-f]{64})_(\d+)$/.exec(deploy.fields.bcn ?? '')
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
      if (chunks.length !== 2 || chunks[0]?.data?.length !== 32) return invalid('the release secret is not canonical')
      const path = tx.merklePath
      if (!path || !Number.isSafeInteger(path.blockHeight) || path.blockHeight <= 0) return missing('the beacon release is not proven mined')
      try {
        if (await path.verify(String(tx.id('hex')), tracker) !== true) return missing('the beacon release is not proven on this chain')
      } catch {
        return missing('the beacon release proof could not be checked')
      }
      return { ok: true, secret: [...chunks[0].data] }
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
