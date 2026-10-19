/**
 * BRC-214 asset profiles: every kind of value the wallet holds, how an app
 * reaches it, and which spending scope covers it. `listAssetProfiles` reveals
 * what the wallet supports, never what it holds.
 */
import { COIN_CHAINS, COIN_INFO } from './coins/coinChains'

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
}

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
  { id: '1sat', scope: 'per-action', spec: ['BRC-147', 'BRC-150', 'BRC-165'], basket: 'p 1sat', spendLabel: 'p 1sat input id' },
  { id: 'p2pft', scope: 'per-action', spec: ['BRC-162', 'BRC-176', 'BRC-251'], basket: 'p p2pft', spendLabel: 'p p2pft input id' },
  { id: 'csft', scope: 'per-action', spec: ['BRC-253'], basket: 'p csft' },
  { id: 'csnft', scope: 'per-action', spec: ['BRC-253'], basket: 'p csnft' },
])

export function listAssetProfiles(): { profiles: AssetProfile[] } {
  return { profiles: ASSET_PROFILES.map((p) => ({ ...p, spec: [...p.spec], ...(p.methods ? { methods: [...p.methods] } : {}) })) }
}
