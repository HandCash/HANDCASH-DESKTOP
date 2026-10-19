import { coinWalletOf } from '../coinMethods'
import { activeAccountSpendRefusal } from '../vaultAccountHolding'
import { getWalletRuntime } from '../walletRuntime'
import { isCoinChain } from './coinChains'
import { COIN_PAYMENT_BOX, type CoinPaymentNotice } from './coinWallet'

/**
 * Box `coin-payment` (BRC-213 §7): notices from wallets that paid this
 * identity on another chain. Each is acknowledged only once its coin is
 * recorded or the notice can never be good; one whose transaction no source
 * knows yet stays in the box, and is dropped after a day.
 */

const POLL_MS = 20_000
const GIVE_UP_MS = 24 * 60 * 60_000

let polledAt = 0
let serving = false
const failingSince = new Map<string, number>()

export function parseCoinPaymentNotice(plaintext: string | null): CoinPaymentNotice | null {
  if (!plaintext) return null
  let raw: unknown
  try {
    raw = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Partial<CoinPaymentNotice>
  if (n.v !== 1 || n.t !== 'coin-payment' || !isCoinChain(n.chain)) return null
  if (typeof n.txid !== 'string' || typeof n.keyId !== 'string' || typeof n.vout !== 'number') return null
  return { v: 1, t: 'coin-payment', chain: n.chain, txid: n.txid, vout: n.vout, keyId: n.keyId }
}

/** One pass over the box, at most every {@link POLL_MS} unless forced. An account held on another device never reads or acknowledges it. */
export async function serveCoinPaymentBox(opts?: { force?: boolean }): Promise<void> {
  const active = getWalletRuntime()?.instance
  if (!active || serving || activeAccountSpendRefusal(active)) return
  const now = Date.now()
  if (!opts?.force && now - polledAt < POLL_MS) return
  polledAt = now
  serving = true
  try {
    const { listSealedOwnBox, acknowledgeOwnBox } = await import('../messageTransport')
    const messages = await listSealedOwnBox(active.rootKeyHex, COIN_PAYMENT_BOX)
    const acks: string[] = []
    for (const m of messages ?? []) {
      if (!m.messageId) continue
      const notice = parseCoinPaymentNotice(m.plaintext)
      if (!notice) {
        acks.push(m.messageId)
        continue
      }
      try {
        const wallet = await coinWalletOf(notice.chain)
        await wallet.ingestPaymentNotice(m.sender, notice)
        failingSince.delete(m.messageId)
        acks.push(m.messageId)
      } catch (err) {
        const since = failingSince.get(m.messageId) ?? now
        failingSince.set(m.messageId, since)
        const message = err instanceof Error ? err.message : String(err)
        if (now - since >= GIVE_UP_MS) {
          console.warn(`[coin-payment] notice ${notice.txid.slice(0, 12)} dropped after a day unread — ${message}`)
          failingSince.delete(m.messageId)
          acks.push(m.messageId)
        } else {
          console.warn(`[coin-payment] notice ${notice.txid.slice(0, 12)} deferred — ${message}`)
        }
      }
    }
    if (acks.length) await acknowledgeOwnBox(active.rootKeyHex, COIN_PAYMENT_BOX, acks).catch(() => {})
  } finally {
    serving = false
  }
}

export function resetCoinPaymentBoxForTest(): void {
  polledAt = 0
  serving = false
  failingSince.clear()
}
