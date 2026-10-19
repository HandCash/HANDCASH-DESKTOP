import { storageRegistry } from '../../storage/registry'
import { createCoinWallet } from '../coins/coinWallet'
import { ltcTxid } from '../ltc/litecoin'
import type { CoinProofRules } from '../ltc/verify'
import { bchCoinAddress, bchCoinScript, bchOutputScript, formatBch, parseBchTx, serializeBchTx, signP2pkhForkIdInputs } from './bitcoincash'
import { defaultBchChain } from './chain'
import { BCH_BURIAL_DEPTH, getBchAnchor } from './headers'

/**
 * Native Bitcoin Cash (BRC-213, Bitcoin Cash binding): the coin engine in
 * `coins/coinWallet.ts` with a P2PKH key of its own, CashAddr addresses,
 * `SIGHASH_ALL | SIGHASH_FORKID` signatures, a SHA-256d + ASERT header chain
 * and Fulcrum servers. Payments go only to CashAddr addresses: a legacy `1…`
 * address is also a BSV address, and coins sent to the wrong chain are lost.
 */

/** Satoshis per BCH. */
export const BCH_DECIMALS = 8
/** Bitcoin Cash Node's dust threshold for a P2PKH output, in satoshis. */
export const BCH_DUST = 546n
export const BCH_PAYMENT_ETA = 'One Bitcoin Cash block, about 10 min'

/** P2PKH input: outpoint 36 + script length 1 + (push 73-byte signature + push 33-byte key) 108 + sequence 4. */
const P2PKH_INPUT_BYTES = 149
/** Version, input and output counts, lock time. */
const TX_OVERHEAD_BYTES = 10

export const BCH_PROOF_RULES: CoinProofRules = {
  label: 'Bitcoin Cash',
  tag: 'bch',
  unit: 'satoshis',
  depth: BCH_BURIAL_DEPTH,
  parseTx: parseBchTx,
  anchor: getBchAnchor,
}

export const bchWallet = createCoinWallet({
  chain: 'bch',
  label: 'Bitcoin Cash',
  ticker: 'BCH',
  decimals: BCH_DECIMALS,
  dust: BCH_DUST,
  paymentEta: BCH_PAYMENT_ETA,
  storageKey: storageRegistry.bch.key,
  keyProtocol: [2, 'bch coin'],
  keyId: '1',
  paymentProtocol: [2, 'bch coin payment'],
  activity: { receive: 'bch-receive', send: 'bch-send' },
  proof: BCH_PROOF_RULES,
  defaultSource: defaultBchChain,
  address: bchCoinAddress,
  script: bchCoinScript,
  outputScript: bchOutputScript,
  sign: signP2pkhForkIdInputs,
  serialize: serializeBchTx,
  txid: ltcTxid,
  size: { overhead: TX_OVERHEAD_BYTES, input: P2PKH_INPUT_BYTES },
  sequence: 0xffffffff,
  format: formatBch,
})
