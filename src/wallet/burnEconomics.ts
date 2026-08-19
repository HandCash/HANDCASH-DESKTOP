export type BurnEconomics = {
  grossAssetSats: number
  protocolOutputSats: number
  recoverableSats: number
  estimatedFeeSats: number
  estimatedPayEffectSats: number
}

/**
 * Conservative preview only; the toolbox remains authoritative for the fee.
 * Inputs are standard P2PKH unlocks, while asset outputs include inscription
 * envelopes, so budget 180 bytes for each output instead of pretending they
 * are ordinary 34-byte P2PKH outputs.
 */
export function estimateBurnEconomics(args: {
  inputCount: number
  protocolOutputCount: number
  recoveryOutput: boolean
  grossAssetSats?: number
  feeRateSatPerKb?: number
}): BurnEconomics {
  const inputCount = Math.max(0, Math.trunc(args.inputCount))
  const protocolOutputCount = Math.max(0, Math.trunc(args.protocolOutputCount))
  const grossAssetSats = Math.max(
    0,
    Math.trunc(args.grossAssetSats ?? inputCount),
  )
  const protocolOutputSats = protocolOutputCount
  const recoverableSats = Math.max(0, grossAssetSats - protocolOutputSats)
  const outputCount = protocolOutputCount + (args.recoveryOutput ? 1 : 0)
  const bytes = 10 + inputCount * 148 + outputCount * 180
  const rate = Math.max(0, args.feeRateSatPerKb ?? 100)
  const estimatedFeeSats = Math.ceil((bytes * rate) / 1000)
  return {
    grossAssetSats,
    protocolOutputSats,
    recoverableSats,
    estimatedFeeSats,
    estimatedPayEffectSats: recoverableSats - estimatedFeeSats,
  }
}
