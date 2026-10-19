/**
 * BRC-213 §9: one method set for every UTXO chain the wallet holds natively,
 * named by `chain` (Litecoin, Bitcoin Cash, Bitcoin, Dogecoin). Litecoin's earlier method names
 * (`getLtcDepositAddress`, `listLtcDeposits`, `withdrawLtc`) stay as aliases.
 *
 * `withdrawLtc` is not a second payment path: the bridge rewrites it to
 * `sendCoins` on chain `ltc` before any gate, so every coin payment takes the
 * same preflight, prompt, budget and holding guard, and only the legacy
 * response is reshaped.
 */
import type { CoinWallet, CoinWalletReport, SendCoinArgs, SendCoinResult } from './coins/coinWallet'
import { COIN_CHAINS, isCoinChain, type CoinChain } from './coins/coinChains'

export { COIN_CHAINS, type CoinChain }

export class CoinRefusal extends Error {
  readonly code = 'COIN_UNSUPPORTED_CHAIN'
  constructor(chain: unknown) {
    super(
      typeof chain === 'string' && chain
        ? `This wallet holds no coins on chain "${chain}". Supported: ${COIN_CHAINS.join(', ')}.`
        : `chain is required. Supported: ${COIN_CHAINS.join(', ')}.`,
    )
    this.name = 'CoinRefusal'
  }
}

function record(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
}

export function coinChainOf(args: unknown): CoinChain {
  const chain = record(args).chain
  if (!isCoinChain(chain)) throw new CoinRefusal(chain)
  return chain
}

/** The wallet engine for `chain`, loaded on first use. */
export async function coinWalletOf(chain: CoinChain): Promise<CoinWallet> {
  switch (chain) {
    case 'ltc':
      return (await import('./ltc/ltcWallet')).ltcWallet
    case 'bch':
      return (await import('./bch/bchWallet')).bchWallet
    case 'btc':
      return (await import('./btc/btcWallet')).btcWallet
    case 'doge':
      return (await import('./doge/dogeWallet')).dogeWallet
  }
}

/** The payment a `sendCoins` call asks for, in the engine's terms. */
export function coinPaymentArgs(args: unknown): SendCoinArgs {
  const body = record(args)
  return { address: body.address, litoshi: body.amount, ...(body.identityKey !== undefined ? { identityKey: body.identityKey } : {}) }
}

/** A `sendCoins` call's chain, or the 400 to answer with. */
export function sendCoinsChain(args: unknown): { ok: true; chain: CoinChain } | { ok: false; status: number; body: string } {
  try {
    return { ok: true, chain: coinChainOf(args) }
  } catch (err) {
    const refusal = err as CoinRefusal
    return { ok: false, status: 400, body: JSON.stringify({ status: 'error', code: refusal.code, description: refusal.message }) }
  }
}

/** `withdrawLtc` arguments as the `sendCoins` call they are. */
export function withdrawLtcAsSendCoins(args: unknown): { chain: 'ltc'; address: unknown; amount: unknown; description?: string } {
  const body = record(args)
  return {
    chain: 'ltc',
    address: body.address,
    amount: body.litoshi,
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
  }
}

/** A `sendCoins` response as `withdrawLtc` answered: `ltcTxid` / `litoshi`, `LTC_` codes. */
export function sendCoinsResponseAsWithdrawLtc(response: { status: number; body: string }): { status: number; body: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    return response
  }
  const body = record(parsed)
  if (response.status >= 200 && response.status < 300 && typeof body.txid === 'string') {
    return { status: response.status, body: JSON.stringify({ ltcTxid: body.txid, litoshi: body.amount, fee: body.fee, status: body.status }) }
  }
  if (typeof body.code === 'string' && body.code.startsWith('COIN_')) {
    return { status: response.status, body: JSON.stringify({ ...body, code: `LTC_${body.code.slice(5)}` }) }
  }
  return response
}

/** BRC-213 §9 `sendCoins` result. */
export function sendCoinsResult(chain: CoinChain, sent: SendCoinResult) {
  return { chain, txid: sent.ltcTxid, amount: sent.litoshi, fee: sent.fee, status: sent.status }
}

export type CoinState = 'unconfirmed' | 'confirming' | 'spendable' | 'unchecked' | 'missing' | 'abandoned'

export type ListCoinsResult = {
  chain: CoinChain
  address: string
  spendable: string
  confirming: string
  coins: Array<{
    txid: string
    vout: number
    amount: string
    source: 'received' | 'change'
    state: CoinState
    confirmations?: number
    needed: number
    spent: boolean
  }>
  payments: Array<{
    txid: string
    address: string
    amount: string
    fee: string
    status: 'signed' | 'sent'
    confirmed: boolean
    lastError?: string
    /** Paid to an identity (BRC-213 §7); `notified` once the recipient's box took the notice. */
    to?: { identityKey: string; notified: boolean }
  }>
}

/** BRC-213 §9 `listCoins` from the wallet's report for `chain`. */
export function listCoinsFromReport(
  chain: CoinChain,
  report: CoinWalletReport,
  count: (phase: CoinWalletReport['coins'][number]['phase']) => { counted: number; needed: number },
): ListCoinsResult {
  return {
    chain,
    address: report.address,
    spendable: report.balance.spendable,
    confirming: report.balance.confirming,
    coins: report.coins.map((c) => {
      const state: CoinState = c.phase.kind === 'movable' ? 'spendable' : c.phase.kind
      const { counted, needed } = count(c.phase)
      return {
        txid: c.txid,
        vout: c.vout,
        amount: c.litoshi,
        source: c.source,
        state,
        ...(state !== 'spendable' && c.source === 'received' ? { confirmations: counted } : {}),
        needed,
        spent: c.spent,
      }
    }),
    payments: report.payments.map((p) => ({
      txid: p.ltcTxid,
      address: p.address,
      amount: p.litoshi,
      fee: p.fee,
      status: p.status,
      confirmed: p.confirmed,
      ...(p.lastError ? { lastError: p.lastError } : {}),
      ...(p.to ? { to: p.to } : {}),
    })),
  }
}
