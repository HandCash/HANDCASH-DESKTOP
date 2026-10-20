import { classifyTipKind } from './collectableTipKind'

export type BurnRefusalReason =
  | 'no_tips'
  | 'unknown_lock'
  | 'covenant_locked'
  | 'not_owned'
  | 'not_one_sat'

export type BurnInput = {
  outpoint: string
  satoshis: number
  lockingScript: string
}

export type OneSatBurnPlan =
  | { path: 'refuse'; asset: '1sat'; reason: BurnRefusalReason }
  | {
      path: 'burnOneSat'
      asset: '1sat'
      inputs: BurnInput[]
      /** All selected ordinal sats are packed into one managed self-payment. */
      recoverSatoshis: number
    }

export type BurnPlan = OneSatBurnPlan

/** Output value that terminates item identity while preserving asset sats. */
export function burnRecoveryOutputSatoshis(
  plan: Exclude<BurnPlan, { path: 'refuse' }>,
): number {
  return plan.recoverSatoshis <= 0 ? 0 : Math.max(2, plan.recoverSatoshis)
}

/** Plan destruction of ordinal identity while preserving its physical sats. */
export function planOneSatBurn(args: {
  tips: Array<{
    outpoint: string
    satoshis: number
    lockingScript?: string
  }>
  ownsLockingScript: (lockingScript: string) => boolean
}): OneSatBurnPlan {
  if (args.tips.length === 0) {
    return { path: 'refuse', asset: '1sat', reason: 'no_tips' }
  }
  const inputs: BurnInput[] = []
  for (const tip of args.tips) {
    if (Math.trunc(tip.satoshis) !== 1) {
      return { path: 'refuse', asset: '1sat', reason: 'not_one_sat' }
    }
    const kind = classifyTipKind(tip.lockingScript)
    if (kind.kind === 'covenantLocked') {
      return { path: 'refuse', asset: '1sat', reason: 'covenant_locked' }
    }
    if (kind.kind === 'unknown') {
      return { path: 'refuse', asset: '1sat', reason: 'unknown_lock' }
    }
    if (!args.ownsLockingScript(kind.lockingScript)) {
      return { path: 'refuse', asset: '1sat', reason: 'not_owned' }
    }
    inputs.push({
      outpoint: tip.outpoint,
      satoshis: 1,
      lockingScript: kind.lockingScript,
    })
  }
  return {
    path: 'burnOneSat',
    asset: '1sat',
    inputs,
    recoverSatoshis: inputs.length,
  }
}
