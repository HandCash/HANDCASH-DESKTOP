import type { PrivateKey } from '@bsv/sdk'
import { storageRegistry } from '../../storage/registry'
import { accountLocalKey } from '../accountLocalKeys'
import { upgradeActivityRows, type ActivityEntry } from '../appActivity'
import {
  CoinRefusalError,
  createCoinWallet,
  EXPECT_COINS_MS,
  planCoinPayment,
  type CoinAppCoin,
  type CoinAppReport,
  type CoinBalance,
  type CoinPaymentPlan,
  type CoinPaymentStatus,
  type CoinStatus,
  type CoinStore,
  type CoinWalletReport,
  type Payment,
  type SendCoinResult,
} from '../coins/coinWallet'
import { durableGetItem } from '../durableStorage'
import { defaultLtcChain, type LtcChain } from './chain'
import type { CoinDepositPhase } from '../coins/depositPhase'
import { formatLtc, ltcOutputScript, ltcTxid, p2wpkhAddress, p2wpkhScript, serializeLtcTx, signP2wpkhInputs } from './litecoin'
import { LTC_PROOF_RULES, type LtcBurialProof } from './verify'

/**
 * Native Litecoin (BRC-213, Litecoin binding): the coin engine in
 * `coins/coinWallet.ts` with Litecoin's key, P2WPKH scripts, BIP143 signing,
 * scrypt header chain and explorers. It also carries over, once per account,
 * the record of the wLTC bridge that earlier versions ran.
 */

/** Litoshi per LTC. */
export const LTC_DECIMALS = 8
/** Smallest output a payment pays or keeps as change, in litoshi. */
export const LTC_DUST = 1_000n
/** When a payment's LTC lands: its first Litecoin block. */
export const LTC_PAYMENT_ETA = 'One Litecoin block, about 2.5 min'

/** Earlier versions received litecoin here as the "wLTC reserve"; the derivation must not change or those coins are lost. */
const LTC_KEY_PROTOCOL: [2, string] = [2, 'wltc reserve']
const LTC_KEY_ID = '1'

/** P2WPKH: 41 bytes + a 107-byte witness at a quarter weight. */
const P2WPKH_INPUT_VBYTES = 68
const TX_OVERHEAD_VBYTES = 11

export { CoinRefusalError as LtcRefusal, EXPECT_COINS_MS }
export type LtcBalance = CoinBalance
export type LtcPaymentPlan = CoinPaymentPlan
export type LtcCoinStatus = CoinStatus
export type LtcPaymentStatus = CoinPaymentStatus
export type LtcWalletReport = CoinWalletReport
export type SendLtcResult = SendCoinResult
export type LtcAppCoin = CoinAppCoin
export type LtcAppPayment = CoinPaymentStatus
export type LtcAppReport = CoinAppReport

// ── Carry over the wLTC record ──────────────────────────────────────────────

type LegacyDeposit = {
  litoshi: string
  status: string
  at: number
  bsvTxid?: string
  proven?: boolean
  phase?: CoinDepositPhase
  proof?: LtcBurialProof
  goneAt?: number
}
type LegacyWithdrawal = Omit<Payment, 'status'> & { status: 'signed' | 'burned' | 'sent'; bsvTxid?: string; burn?: string }
type LegacyRecord = { deposits?: Record<string, LegacyDeposit>; withdrawals?: Record<string, LegacyWithdrawal> }

/**
 * Once per account: the coins the wLTC bridge recorded become this wallet's
 * coins. A withdrawal whose burn committed owes its payout, so it is kept to
 * broadcast; one never burned was never owed and is dropped. The wLTC tokens
 * themselves are left as they are and no longer count for anything.
 */
function migrateWltc(store: CoinStore): void {
  const state = store.read()
  if (state.migrated) return
  let legacy: LegacyRecord = {}
  try {
    legacy = JSON.parse(durableGetItem(accountLocalKey(storageRegistry.wltc.key)) ?? '{}')
  } catch {
    legacy = {}
  }
  for (const [key, d] of Object.entries(legacy.deposits ?? {})) {
    if (d.status !== 'credited' || state.coins[key]) continue
    state.coins[key] = {
      litoshi: d.litoshi,
      at: d.at,
      source: 'received',
      ...(d.proven !== false ? { proven: true as const } : {}),
      ...(d.phase ? { phase: d.phase } : {}),
      ...(d.proof ? { proof: d.proof } : {}),
      ...(d.goneAt ? { goneAt: d.goneAt } : {}),
    }
  }
  for (const [txid, w] of Object.entries(legacy.withdrawals ?? {})) {
    if (w.status === 'signed' || state.payments[txid]) continue
    const { status, bsvTxid: _mint, burn: _burn, ...rest } = w
    state.payments[txid] = { ...rest, status: status === 'sent' ? 'sent' : 'signed' }
    if (w.change) state.coins[`${txid}:${w.change.vout}`] = { litoshi: w.change.litoshi, at: w.at, source: 'change' }
  }
  state.migrated = true
  store.write(state)
  const coins = Object.keys(state.coins).length
  const rows = upgradeActivityRows((entry) => nativeLtcRow(entry, legacy))
  if (coins > 0 || rows > 0) console.info(`[ltc] carried over ${coins} coins and ${rows} activity rows from the wLTC record`)
}

const ltcWallet = createCoinWallet({
  chain: 'ltc',
  label: 'Litecoin',
  ticker: 'LTC',
  decimals: LTC_DECIMALS,
  dust: LTC_DUST,
  paymentEta: LTC_PAYMENT_ETA,
  storageKey: storageRegistry.ltc.key,
  keyProtocol: LTC_KEY_PROTOCOL,
  keyId: LTC_KEY_ID,
  paymentProtocol: [2, 'ltc coin payment'],
  activity: { receive: 'ltc-receive', send: 'ltc-send' },
  proof: LTC_PROOF_RULES,
  defaultSource: defaultLtcChain,
  address: p2wpkhAddress,
  script: p2wpkhScript,
  outputScript: ltcOutputScript,
  sign: signP2wpkhInputs,
  serialize: serializeLtcTx,
  txid: ltcTxid,
  size: { overhead: TX_OVERHEAD_VBYTES, input: P2WPKH_INPUT_VBYTES },
  sequence: 0xfffffffd,
  format: formatLtc,
  migrate: migrateWltc,
})

export { ltcWallet }

/**
 * The native row an earlier wLTC row stands for, or null to keep it. Those
 * rows named the BSV mint or burn; the native row names the Litecoin
 * transaction that moved the coins.
 */
export function nativeLtcRow(entry: ActivityEntry, legacy: LegacyRecord): Omit<ActivityEntry, 'id' | 'at'> | null {
  if (entry.method === 'wltc-credit') {
    const named = entry.note?.match(/([0-9a-f]{64}:\d+)/)?.[1]
    const key = named ?? Object.entries(legacy.deposits ?? {}).find(([, d]) => d.bsvTxid && d.bsvTxid === entry.txid)?.[0]
    const deposit = key ? legacy.deposits?.[key] : undefined
    if (!key || !deposit) return null
    return {
      origin: entry.origin,
      kind: 'earned',
      sats: 0,
      method: 'ltc-receive',
      note: `Litecoin ${key}`,
      txid: key.split(':')[0]!,
      item: ltcWallet.activityItem(BigInt(deposit.litoshi)),
    }
  }
  if (entry.method === 'wltc-withdraw') {
    const found = Object.entries(legacy.withdrawals ?? {}).find(([, w]) => w.bsvTxid && w.bsvTxid === entry.txid)
    if (!found) return null
    const [txid, w] = found
    return {
      origin: entry.origin,
      kind: 'spent',
      sats: 0,
      method: 'ltc-send',
      note: `To ${w.address} · ${formatLtc(BigInt(w.fee))} LTC network fee`,
      txid,
      item: ltcWallet.activityItem(BigInt(w.litoshi)),
    }
  }
  return null
}

export const ltcKey = (root: PrivateKey): PrivateKey => ltcWallet.coinKey(root)

export function planLtcPayment(
  coins: ReadonlyArray<{ txid: string; vout: number; litoshi: bigint }>,
  destination: Uint8Array,
  changeScript: Uint8Array,
  litoshi: bigint,
  feeRate: number,
): LtcPaymentPlan | null {
  return planCoinPayment(ltcWallet.binding, coins, destination, changeScript, litoshi, feeRate)
}

export const subscribeLtc = ltcWallet.subscribe
export const ensureLtcMigrated = ltcWallet.ensureMigrated
export const readLtcBalance = ltcWallet.readBalance
export const getLtcAddress = ltcWallet.getAddress
export const preflightSendLtc = ltcWallet.preflightSend
export const sendLtc = ltcWallet.send
export const refreshLtc = ltcWallet.refresh
export const readLtcCoinViews = ltcWallet.readCoinViews
export const watchLtc = ltcWallet.watch
export const startLtcWatcher = ltcWallet.startWatcher
export const resetLtcWatchForTest = ltcWallet.resetWatchForTest
/** `getLtcDepositAddress`: where to send this wallet litecoin. Asking also tells the watcher to expect coins. */
export const ltcAddressForApp = ltcWallet.addressForApp
/** `listLtcDeposits`: read Litecoin now and report coins received and payments made. */
export const listLtcForApp = ltcWallet.listForApp

/** Tests swap the explorer. */
export function setLtcDepsForTest(next: { chain?: LtcChain } | null): void {
  ltcWallet.setSourceForTest(next?.chain ?? null)
}
