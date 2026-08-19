import { classifyBsv21TipKind, type Bsv21Utxo } from './bsv21'
import { classifyTipKind } from './collectableTipKind'

export type BurnRefusalReason =
  | 'invalid_amount'
  | 'insufficient_tokens'
  | 'no_tips'
  | 'cosigner_required'
  | 'mixed_tips'
  | 'unknown_lock'
  | 'covenant_locked'
  | 'not_owned'
  | 'not_one_sat'
  | 'multiple_token_ids'

export type BurnInput = {
  outpoint: string
  satoshis: number
  lockingScript: string
}

export type Bsv21BurnPlan =
  | { path: 'refuse'; asset: 'bsv21'; reason: BurnRefusalReason }
  | {
      path: 'burnBsv21'
      asset: 'bsv21'
      tokenId: string
      burnAmount: bigint
      selectedAmount: bigint
      changeAmount: bigint
      inputs: BurnInput[]
      /** Physical sats left after the burn and optional token-change tips. */
      recoverSatoshis: number
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

export type BurnPlan = Bsv21BurnPlan | OneSatBurnPlan

/** Output value that terminates item identity while preserving asset sats. */
export function burnRecoveryOutputSatoshis(
  plan: Exclude<BurnPlan, { path: 'refuse' }>,
): number {
  if (plan.recoverSatoshis <= 0) return 0
  return plan.path === 'burnOneSat'
    ? Math.max(2, plan.recoverSatoshis)
    : plan.recoverSatoshis
}

function positiveUnits(raw: string | bigint): bigint | null {
  try {
    const value = typeof raw === 'bigint' ? raw : BigInt(raw.trim())
    return value > 0n ? value : null
  } catch {
    return null
  }
}

function exactInput(
  tip: Pick<Bsv21Utxo, 'outpoint' | 'satoshis' | 'lockingScript'>,
): BurnInput | null {
  const lockingScript = tip.lockingScript?.trim().toLowerCase() ?? ''
  const satoshis = Math.trunc(tip.satoshis)
  if (!tip.outpoint.trim() || !lockingScript || satoshis < 0) return null
  return { outpoint: tip.outpoint, satoshis, lockingScript }
}

/**
 * Choose token inputs once, before execution. The whole token-id holding must
 * have one known spend kind; a plain subset never silently bypasses a cosigned,
 * covenant or unknown sibling tip.
 */
export function planBsv21Burn(args: {
  tokenId: string
  amount: string | bigint
  tips: Bsv21Utxo[]
  ownsLockingScript: (lockingScript: string) => boolean
}): Bsv21BurnPlan {
  const burnAmount = positiveUnits(args.amount)
  if (!burnAmount) {
    return { path: 'refuse', asset: 'bsv21', reason: 'invalid_amount' }
  }
  if (args.tips.length === 0) {
    return { path: 'refuse', asset: 'bsv21', reason: 'no_tips' }
  }

  let plain = 0
  let cosigned = 0
  for (const tip of args.tips) {
    if (tip.tokenId.trim().toLowerCase() !== args.tokenId.trim().toLowerCase()) {
      return {
        path: 'refuse',
        asset: 'bsv21',
        reason: 'multiple_token_ids',
      }
    }
    const kind = classifyBsv21TipKind({
      lockingScript: tip.lockingScript,
      cosignClaim: tip.cosign ?? null,
    })
    if (kind.kind === 'unknown') {
      const generic = classifyTipKind(tip.lockingScript)
      if (generic.kind === 'covenantLocked') {
        return { path: 'refuse', asset: 'bsv21', reason: 'covenant_locked' }
      }
      return { path: 'refuse', asset: 'bsv21', reason: 'unknown_lock' }
    }
    if (kind.kind === 'cosigned') cosigned += 1
    else plain += 1
    if (
      !tip.lockingScript ||
      !args.ownsLockingScript(tip.lockingScript)
    ) {
      return { path: 'refuse', asset: 'bsv21', reason: 'not_owned' }
    }
  }
  if (plain > 0 && cosigned > 0) {
    return { path: 'refuse', asset: 'bsv21', reason: 'mixed_tips' }
  }
  if (cosigned > 0) {
    return { path: 'refuse', asset: 'bsv21', reason: 'cosigner_required' }
  }

  const sorted = [...args.tips].sort((a, b) => {
    const aa = positiveUnits(a.amt) ?? 0n
    const bb = positiveUnits(b.amt) ?? 0n
    return bb > aa ? 1 : bb < aa ? -1 : a.outpoint.localeCompare(b.outpoint)
  })
  const selected: Bsv21Utxo[] = []
  let selectedAmount = 0n
  for (const tip of sorted) {
    if (selectedAmount >= burnAmount) break
    const amount = positiveUnits(tip.amt)
    if (!amount) continue
    selected.push(tip)
    selectedAmount += amount
  }
  if (selectedAmount < burnAmount) {
    return { path: 'refuse', asset: 'bsv21', reason: 'insufficient_tokens' }
  }
  const inputs = selected.map(exactInput)
  if (inputs.some((input) => input == null)) {
    return { path: 'refuse', asset: 'bsv21', reason: 'unknown_lock' }
  }
  const changeAmount = selectedAmount - burnAmount
  const tokenOutputSats = 1 + (changeAmount > 0n ? 1 : 0)
  const inputSats = (inputs as BurnInput[]).reduce((sum, input) => sum + input.satoshis, 0)
  return {
    path: 'burnBsv21',
    asset: 'bsv21',
    tokenId: args.tokenId,
    burnAmount,
    selectedAmount,
    changeAmount,
    inputs: inputs as BurnInput[],
    recoverSatoshis: Math.max(0, inputSats - tokenOutputSats),
  }
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
