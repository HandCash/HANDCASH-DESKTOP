/**
 * BRC-214 asset profiles: every kind of value the wallet holds, how an app
 * reaches it, and which spending scope covers it. `listAssetProfiles` reveals
 * what the wallet supports, never what it holds.
 */
import { COIN_CHAINS, COIN_INFO } from './coins/coinChains'
import { arcUsdcLabEnabled } from './arcUsdc'
import { ARC_USDC_DECIMALS } from './arcUsdc/chain'

export type AssetProfile = {
  id: string
  /** `payment`: shares the per-app payment budget. `per-action`: always its own prompt. */
  scope: 'payment' | 'per-action'
  spec: string[]
  chain?: string
  decimals?: number
  minConfirmations?: number
  methods?: string[]
  basket?: string
  spendLabel?: string
  /** Token profiles only: whether every unit passes the six Bitcoin Native Token (BNT) tests of BRC-251. */
  bnt?: boolean
  /** Lab / experimental — omitted unless the matching Labs flag is on. */
  experimental?: boolean
}

/** USDC on Arc — payment currency with its own address / send methods (BCH-shaped). */
const ARC_USD_METHODS = ['getArcUsdAddress', 'listArcUsd', 'sendArcUsd'] as const
const ARC_USD_WRAP_METHODS = [
  'planArcUsdcFractionalize',
  'planArcUsdcRedeem',
  'executeArcUsdcFractionalize',
  'executeArcUsdcRedeem',
  'listArcUsdcWrapClaims',
  'getArcUsdcWrapSpendable',
] as const

const ARC_USD_PROFILE: AssetProfile = Object.freeze({
  id: 'arc-usd',
  scope: 'payment',
  spec: ['arc-usd'],
  chain: 'arc',
  decimals: ARC_USDC_DECIMALS,
  minConfirmations: 1,
  methods: [...ARC_USD_METHODS],
  spendLabel: 'USDC',
})

export const ASSET_PROFILES: readonly AssetProfile[] = Object.freeze([
  { id: 'bsv', scope: 'payment', spec: ['BRC-100'] },
  ...COIN_CHAINS.map((chain) => ({
    id: `coin:${chain}`,
    scope: 'payment' as const,
    spec: ['BRC-213'],
    chain,
    decimals: COIN_INFO[chain].decimals,
    minConfirmations: COIN_INFO[chain].confirmations,
    methods: ['getCoinAddress', 'listCoins', 'sendCoins'],
  })),
  ARC_USD_PROFILE,
  { id: '1sat', scope: 'per-action', spec: ['BRC-147', 'BRC-150', 'BRC-165'], basket: 'p 1sat', spendLabel: 'p 1sat input id' },
  { id: 'bntft', scope: 'per-action', spec: ['BRC-251', 'BRC-255'], basket: 'p bntft', bnt: true },
  { id: 'bntnft', scope: 'per-action', spec: ['BRC-255'], basket: 'p bntnft', bnt: true },
  { id: 'iptft', scope: 'per-action', spec: ['BRC-253'], basket: 'p iptft', bnt: false },
  { id: 'iptnft', scope: 'per-action', spec: ['BRC-253'], basket: 'p iptnft', bnt: false },
])

function cloneProfile(p: AssetProfile): AssetProfile {
  return {
    ...p,
    spec: [...p.spec],
    ...(p.methods ? { methods: [...p.methods] } : {}),
  }
}

export function listAssetProfiles(): { profiles: AssetProfile[] } {
  const profiles = ASSET_PROFILES.map(cloneProfile)
  if (arcUsdcLabEnabled()) {
    const arc = profiles.find((p) => p.id === 'arc-usd')
    if (arc) {
      arc.methods = [...ARC_USD_METHODS, ...ARC_USD_WRAP_METHODS]
      arc.experimental = true
      arc.spec = ['arc-usd', 'lab:arcUsdc']
      arc.spendLabel = 'USDC (wrap lab on)'
    }
  }
  return { profiles }
}
