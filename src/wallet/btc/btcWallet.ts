import { storageRegistry } from '../../storage/registry'
import { createCoinWallet } from '../coins/coinWallet'
import { ltcTxid, parseLtcTx, serializeLtcTx, signP2wpkhInputs } from '../ltc/litecoin'
import type { CoinProofRules } from '../ltc/verify'
import { btcCoinAddress, btcCoinScript, btcOutputScript, formatBtc } from './bitcoin'
import { defaultBtcChain } from './chain'
import { BTC_BURIAL_DEPTH, getBtcAnchor } from './headers'

/**
 * Native Bitcoin (BRC-213, Bitcoin binding): the coin engine in
 * `coins/coinWallet.ts` with a P2WPKH key of its own, `bc1q` addresses, BIP143
 * signatures, a SHA-256d header chain retargeting every 2016 blocks, and
 * Electrum servers. Payments go to `bc1` and `3…` addresses only: a legacy
 * `1…` address is also a BSV address, and coins sent to the wrong chain are
 * lost.
 */

/** Satoshis per BTC. */
export const BTC_DECIMALS = 8
/** Bitcoin Core's dust threshold for a P2PKH output; it covers every output type this wallet pays. */
export const BTC_DUST = 546n
export const BTC_PAYMENT_ETA = 'One Bitcoin block, about 10 min'

/** P2WPKH: 41 bytes + a 107-byte witness at a quarter weight. */
const P2WPKH_INPUT_VBYTES = 68
const TX_OVERHEAD_VBYTES = 11

export const BTC_PROOF_RULES: CoinProofRules = {
  label: 'Bitcoin',
  tag: 'btc',
  unit: 'satoshis',
  depth: BTC_BURIAL_DEPTH,
  parseTx: parseLtcTx,
  anchor: getBtcAnchor,
}

export const btcWallet = createCoinWallet({
  chain: 'btc',
  label: 'Bitcoin',
  ticker: 'BTC',
  decimals: BTC_DECIMALS,
  dust: BTC_DUST,
  paymentEta: BTC_PAYMENT_ETA,
  storageKey: storageRegistry.btc.key,
  keyProtocol: [2, 'btc coin'],
  keyId: '1',
  paymentProtocol: [2, 'btc coin payment'],
  activity: { receive: 'btc-receive', send: 'btc-send' },
  proof: BTC_PROOF_RULES,
  defaultSource: defaultBtcChain,
  address: btcCoinAddress,
  script: btcCoinScript,
  outputScript: btcOutputScript,
  sign: signP2wpkhInputs,
  serialize: serializeLtcTx,
  txid: ltcTxid,
  size: { overhead: TX_OVERHEAD_VBYTES, input: P2WPKH_INPUT_VBYTES },
  sequence: 0xfffffffd,
  format: formatBtc,
})
