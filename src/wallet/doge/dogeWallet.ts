import { storageRegistry } from '../../storage/registry'
import { createCoinWallet } from '../coins/coinWallet'
import { ltcTxid } from '../ltc/litecoin'
import type { CoinProofRules } from '../ltc/verify'
import { defaultDogeChain } from './chain'
import { dogeCoinAddress, dogeCoinScript, dogeOutputScript, formatDoge, parseDogeTx, serializeDogeTx, signP2pkhLegacyInputs } from './dogecoin'
import { DOGE_BURIAL_DEPTH, getDogeAnchor } from './headers'

/**
 * Native Dogecoin (BRC-213, Dogecoin binding): the coin engine in
 * `coins/coinWallet.ts` with a P2PKH key of its own, `D…` addresses, legacy
 * `SIGHASH_ALL` signatures, a header chain whose merge-mined work is checked
 * through each block's AuxPoW, DigiShield difficulty, and ElectrumX servers.
 */

/** Koinu per DOGE. */
export const DOGE_DECIMALS = 8
/** Dogecoin Core's soft dust limit, 0.01 DOGE: smaller outputs cost their own value in fees to relay. */
export const DOGE_DUST = 1_000_000n
export const DOGE_PAYMENT_ETA = 'One Dogecoin block, about 1 min'

/** P2PKH input: outpoint 36 + script length 1 + (push 73-byte signature + push 33-byte key) 108 + sequence 4. */
const P2PKH_INPUT_BYTES = 149
/** Version, input and output counts, lock time. */
const TX_OVERHEAD_BYTES = 10

export const DOGE_PROOF_RULES: CoinProofRules = {
  label: 'Dogecoin',
  tag: 'doge',
  unit: 'koinu',
  depth: DOGE_BURIAL_DEPTH,
  parseTx: parseDogeTx,
  anchor: getDogeAnchor,
}

export const dogeWallet = createCoinWallet({
  chain: 'doge',
  label: 'Dogecoin',
  ticker: 'DOGE',
  decimals: DOGE_DECIMALS,
  dust: DOGE_DUST,
  paymentEta: DOGE_PAYMENT_ETA,
  storageKey: storageRegistry.doge.key,
  keyProtocol: [2, 'doge coin'],
  keyId: '1',
  paymentProtocol: [2, 'doge coin payment'],
  activity: { receive: 'doge-receive', send: 'doge-send' },
  proof: DOGE_PROOF_RULES,
  defaultSource: defaultDogeChain,
  address: dogeCoinAddress,
  script: dogeCoinScript,
  outputScript: dogeOutputScript,
  sign: signP2pkhLegacyInputs,
  serialize: serializeDogeTx,
  txid: ltcTxid,
  size: { overhead: TX_OVERHEAD_BYTES, input: P2PKH_INPUT_BYTES },
  sequence: 0xffffffff,
  format: formatDoge,
})
