import { electrumCoinChain, failoverElectrumChain, electrumSocket, type ElectrumCoinChain, type ElectrumProfile, type Rpc } from '../coins/electrumChain'
import { bchOutputScript } from './bitcoincash'

/** Bitcoin Cash sources: Fulcrum servers over the generic Electrum source (`coins/electrumChain.ts`). */

export type BchChain = ElectrumCoinChain
export { electrumScriptHash, electrumSocket } from '../coins/electrumChain'

/** Independent public Fulcrum servers, tried in order. */
export const BCH_FULCRUM_SERVERS = [
  'wss://bch.imaginary.cash:50004',
  'wss://electrum.imaginary.cash:50004',
  'wss://bch.loping.net:50004',
  'wss://fulcrum.greyh.at:50004',
] as const

export const BCH_ELECTRUM: ElectrumProfile = {
  label: 'Bitcoin Cash',
  outputScript: bchOutputScript,
  // Bitcoin Cash blocks do not fill, so a server asking more than 5 sat/byte is not believed.
  feeRate: { min: 1, max: 5 },
  // CashTokens outputs are never this wallet's coins; their scripts would not match anyway.
  skipCoin: (row) => row.token_data !== undefined,
}

export const electrumBchChain = (rpc: Rpc): BchChain => electrumCoinChain(rpc, BCH_ELECTRUM)

export const failoverBchChain = (chains: readonly BchChain[]): BchChain => failoverElectrumChain(chains, 'Bitcoin Cash')

let shared: BchChain | null = null

/** The wallet's Bitcoin Cash servers, one socket each, opened on first use. */
export function defaultBchChain(): BchChain {
  return (shared ??= failoverBchChain(BCH_FULCRUM_SERVERS.map((url) => electrumBchChain(electrumSocket(url)))))
}
