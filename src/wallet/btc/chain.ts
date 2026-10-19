import { electrumCoinChain, electrumSocket, failoverElectrumChain, type ElectrumCoinChain, type ElectrumProfile, type Rpc } from '../coins/electrumChain'
import { btcOutputScript } from './bitcoin'

/** Bitcoin sources: public Fulcrum / ElectrumX servers over the generic Electrum source (`coins/electrumChain.ts`). */

export type BtcChain = ElectrumCoinChain

/** Independent public servers that speak Electrum over WebSocket, tried in order. */
export const BTC_ELECTRUM_SERVERS = [
  'wss://fulcrum.grey.pw:50004',
  'wss://bitcoinserver.nl:50004',
  'wss://btc.electroncash.dk:60004',
  'wss://electrum1.cipig.net:30000',
  'wss://electrum2.cipig.net:30000',
] as const

export const BTC_ELECTRUM: ElectrumProfile = {
  label: 'Bitcoin',
  outputScript: btcOutputScript,
  // About an hour, as Litecoin payments aim for.
  feeTarget: 6,
  // Sats per virtual byte. Above 500 a server is not believed: the payment waits rather than overpays.
  feeRate: { min: 1, max: 500 },
}

export const electrumBtcChain = (rpc: Rpc): BtcChain => electrumCoinChain(rpc, BTC_ELECTRUM)

let shared: BtcChain | null = null

/** The wallet's Bitcoin servers, one socket each, opened on first use. */
export function defaultBtcChain(): BtcChain {
  return (shared ??= failoverElectrumChain(
    BTC_ELECTRUM_SERVERS.map((url) => electrumBtcChain(electrumSocket(url))),
    'Bitcoin',
  ))
}
