import { electrumCoinChain, electrumSocket, failoverElectrumChain, type ElectrumCoinChain, type ElectrumProfile, type Rpc } from '../coins/electrumChain'
import { dogeOutputScript, splitDogeHeaders } from './dogecoin'

/**
 * Dogecoin sources: ElectrumX servers over the generic Electrum source
 * (`coins/electrumChain.ts`). They serve each header with its AuxPoW, so the
 * wallet checks merge-mined work itself.
 */

export type DogeChain = ElectrumCoinChain

/** Public ElectrumX servers that speak Electrum over WebSocket and serve full AuxPoW headers. */
export const DOGE_ELECTRUM_SERVERS = ['wss://electrum1.cipig.net:30060', 'wss://electrum2.cipig.net:30060', 'wss://electrum3.cipig.net:30060'] as const

export const DOGE_ELECTRUM: ElectrumProfile = {
  label: 'Dogecoin',
  outputScript: dogeOutputScript,
  splitHeaders: splitDogeHeaders,
  // About 900 bytes a header with its AuxPoW: 200 stay well under a server's answer limit.
  maxHeadersPerCall: 200,
  feeTarget: 6,
  // Koinu per byte: Dogecoin Core's recommended 0.01 DOGE/kB floor; above 0.1 DOGE/kB a server is not believed.
  feeRate: { min: 1_000, max: 10_000 },
}

export const electrumDogeChain = (rpc: Rpc): DogeChain => electrumCoinChain(rpc, DOGE_ELECTRUM)

let shared: DogeChain | null = null

/** The wallet's Dogecoin servers, one socket each, opened on first use. */
export function defaultDogeChain(): DogeChain {
  return (shared ??= failoverElectrumChain(
    DOGE_ELECTRUM_SERVERS.map((url) => electrumDogeChain(electrumSocket(url))),
    'Dogecoin',
  ))
}
