import type { Transaction } from '@bsv/sdk'
import {
  beaconLock,
  disclosedReleaseKeys,
  readBeaconMarker,
  type CountersignKeySets,
} from './script'

/**
 * Phases of a countersigned asset, read from its beacon chain alone:
 * live → ended (retired | lapsed) → released. A lapse is permanent; a release
 * publishes the release private keys, after which anyone countersigns.
 */
export type CountersignPhase =
  | { phase: 'live' }
  | { phase: 'ended'; why: 'retired' | 'lapsed'; beacon: string }
  | { phase: 'released'; txid: string; keys: string[] }

export type BeaconStep = {
  /** `txid_vout` of this beacon output. */
  outpoint: string
  /** Block time in seconds; absent while unmined. */
  blockTime?: number
  /** Written by a retire: this is the final beacon. */
  retired?: boolean
}

export type BeaconChainView = {
  steps: BeaconStep[]
  /** The release that spent the last step, when there is one. */
  release?: { txid: string; keys: string[] }
}

/**
 * The phase rule. A mempool refresh does not count: a lapse is measured from
 * the last mined beacon, either to the next mined one or to the chain tip.
 */
export function beaconPhase(view: BeaconChainView, tipTime: number | null, sil: number): CountersignPhase {
  if (view.release) return { phase: 'released', txid: view.release.txid, keys: view.release.keys }
  const last = view.steps[view.steps.length - 1]
  const retired = view.steps.find((step) => step.retired)
  if (retired) return { phase: 'ended', why: 'retired', beacon: retired.outpoint }
  let lastMined: BeaconStep | undefined
  for (const step of view.steps) {
    if (step.blockTime == null) break
    if (lastMined?.blockTime != null && step.blockTime - lastMined.blockTime > sil) {
      return { phase: 'ended', why: 'lapsed', beacon: last!.outpoint }
    }
    lastMined = step
  }
  if (lastMined?.blockTime != null && tipTime != null && tipTime - lastMined.blockTime > sil) {
    return { phase: 'ended', why: 'lapsed', beacon: last!.outpoint }
  }
  return { phase: 'live' }
}

/** What the reader needs from any chain source. `undefined` is "no answer", never a negative. */
export type BeaconChainSource = {
  /** Spending txid, null when unspent. */
  spentBy(txid: string, vout: number): Promise<string | null | undefined>
  tx(txid: string): Promise<Transaction | null>
  /** Block time in seconds, null while unmined. */
  blockTime(txid: string): Promise<number | null | undefined>
  /** The chain tip's time in seconds. */
  tipTime(): Promise<number | null>
}

const MAX_STEPS = 2_000

/**
 * Follow the beacon from `from` (a known view, or the deploy's output 1),
 * spend by spend. Unmined steps are asked for their block time again; a step
 * the source cannot answer for ends the walk with what is known.
 */
export async function readBeaconChain(args: {
  assetId: string
  sets: CountersignKeySets
  source: BeaconChainSource
  known?: BeaconChainView
}): Promise<BeaconChainView> {
  const { assetId, sets, source } = args
  const lock = beaconLock(sets).toHex()
  const steps: BeaconStep[] = args.known?.steps.length
    ? args.known.steps.map((s) => ({ ...s }))
    : [{ outpoint: `${assetId.slice(0, 64)}_1` }]
  if (args.known?.release) return { steps, release: args.known.release }
  for (const step of steps) {
    if (step.blockTime != null) continue
    const time = await source.blockTime(step.outpoint.slice(0, 64))
    if (time == null) break
    step.blockTime = time
  }
  while (steps.length < MAX_STEPS) {
    const current = steps[steps.length - 1]!
    const [txid, vout] = current.outpoint.split('_')
    const spender = await source.spentBy(txid!, Number(vout))
    if (!spender) break
    const tx = await source.tx(spender)
    if (!tx) break
    const vin = tx.inputs.findIndex(
      (input) =>
        String(input.sourceTXID ?? input.sourceTransaction?.id('hex') ?? '').toLowerCase() === txid &&
        input.sourceOutputIndex === Number(vout),
    )
    if (vin < 0) break
    const markers = tx.outputs.flatMap((output) => {
      const marker = output.lockingScript ? readBeaconMarker(output.lockingScript) : null
      return marker && marker.assetId === assetId ? [marker] : []
    })
    const nextVout = tx.outputs.findIndex((output) => output.lockingScript?.toHex() === lock)
    const release = markers.find((m) => m.kind === 'release')
    if (nextVout < 0) {
      if (release?.kind === 'release' && disclosedReleaseKeys(release.keys, sets.release)) {
        return { steps, release: { txid: spender, keys: release.keys } }
      }
      break
    }
    const time = await source.blockTime(spender)
    steps.push({
      outpoint: `${spender}_${nextVout}`,
      ...(time != null ? { blockTime: time } : {}),
      ...(markers.some((m) => m.kind === 'retire') ? { retired: true } : {}),
    })
  }
  return { steps }
}
