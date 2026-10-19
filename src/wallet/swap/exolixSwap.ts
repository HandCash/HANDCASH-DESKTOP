import { Utils } from '@bsv/sdk'
import { storageRegistry } from '../../storage/registry'
import { accountLocalKey } from '../accountLocalKeys'
import { durableGetItem, durableSetItem } from '../durableStorage'
import { decimalToUnits, SWAP_ASSET_INFO, unitsToDecimal, type SwapAsset } from './assets'

/**
 * Running a swap through Exolix, wallet to wallet on both ends: the wallet
 * names its own address on the coin it receives (payout) and on the coin it
 * pays (refund), then pays Exolix's deposit address from its own balance.
 * Nothing is pasted, and nothing is paid unless Exolix's exchange matches
 * the quote the user confirmed: the same amount in, at least the quoted
 * amount out, to this wallet's address.
 *
 * Exolix holds the coins between the deposit and its payout. Each swap is
 * recorded before the deposit is paid, so a restart never loses one.
 */

export const EXOLIX_TX_URL = 'https://exolix.com/api/v2/transactions'
const TIMEOUT_MS = 15_000

export type ExolixStatus = 'wait' | 'confirmation' | 'confirmed' | 'exchanging' | 'sending' | 'success' | 'overdue' | 'refunded'
const EXOLIX_STATUSES: readonly ExolixStatus[] = ['wait', 'confirmation', 'confirmed', 'exchanging', 'sending', 'success', 'overdue', 'refunded']
export const EXOLIX_FINAL: readonly ExolixStatus[] = ['success', 'overdue', 'refunded']

export type ExolixExchange = {
  id: string
  from: SwapAsset
  to: SwapAsset
  pay: bigint
  receive: bigint
  depositAddress: string
  withdrawalAddress: string
  status: ExolixStatus
}

export type SwapRecordStage = 'created' | 'paid' | 'pay-failed'

export type SwapRecord = {
  id: string
  via: 'exolix'
  from: SwapAsset
  to: SwapAsset
  pay: string
  receive: string
  depositAddress: string
  payout: string
  stage: SwapRecordStage
  status: ExolixStatus
  txid?: string
  error?: string
  createdAt: number
  updatedAt: number
}

export type SwapRefusalReason = 'unavailable' | 'terms-changed' | 'wrong-payout' | 'bad-deposit' | 'insufficient'

export class SwapRefusal extends Error {
  constructor(
    readonly reason: SwapRefusalReason,
    message: string,
  ) {
    super(message)
    this.name = 'SwapRefusal'
  }
}

type ExchangeBody = {
  id?: unknown
  amount?: unknown
  amountTo?: unknown
  depositAddress?: unknown
  withdrawalAddress?: unknown
  status?: unknown
  message?: unknown
  errors?: unknown
}

async function exolixCall(url: string, init: RequestInit, fetcher: typeof fetch): Promise<ExchangeBody> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetcher(url, { ...init, signal: controller.signal })
    const body = (await res.json().catch(() => ({}))) as ExchangeBody
    if (!res.ok) {
      const detail = typeof body.message === 'string' ? body.message : body.errors ? JSON.stringify(body.errors) : `Exolix ${res.status}`
      throw new SwapRefusal('unavailable', detail)
    }
    return body
  } catch (err) {
    if (err instanceof SwapRefusal) throw err
    throw new SwapRefusal('unavailable', err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timer)
  }
}

function readExchange(body: ExchangeBody, from: SwapAsset, to: SwapAsset): ExolixExchange {
  const pay = typeof body.amount === 'number' || typeof body.amount === 'string' ? decimalToUnits(from, body.amount) : null
  const receive = typeof body.amountTo === 'number' || typeof body.amountTo === 'string' ? decimalToUnits(to, body.amountTo) : null
  const status = EXOLIX_STATUSES.find((s) => s === body.status)
  if (typeof body.id !== 'string' || !body.id || pay === null || receive === null || typeof body.depositAddress !== 'string' || typeof body.withdrawalAddress !== 'string' || !status) {
    throw new SwapRefusal('unavailable', 'Exolix returned an exchange this wallet cannot read.')
  }
  return { id: body.id, from, to, pay, receive, depositAddress: body.depositAddress.trim(), withdrawalAddress: body.withdrawalAddress.trim(), status }
}

/** Whether `address` is a mainnet address on `asset`'s chain. */
export type AddressCheck = (asset: SwapAsset, address: string) => boolean

export function isBsvAddress(address: string): boolean {
  try {
    const { prefix, data } = Utils.fromBase58Check(address)
    return Array.isArray(prefix) && prefix.length === 1 && prefix[0] === 0x00 && data.length === 20
  } catch {
    return false
  }
}

/**
 * Open an Exolix exchange paying `withdrawal` (this wallet, on `to`) and
 * refunding to `refund` (this wallet, on `from`), and check it against the
 * confirmed quote before anything is paid.
 */
export async function createExolixExchange(
  req: { from: SwapAsset; to: SwapAsset; pay: bigint; receive: bigint },
  own: { withdrawal: string; refund: string },
  opts: { fetch?: typeof fetch; validAddress: AddressCheck },
): Promise<ExolixExchange> {
  const from = SWAP_ASSET_INFO[req.from]
  const to = SWAP_ASSET_INFO[req.to]
  const body = await exolixCall(
    EXOLIX_TX_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        coinFrom: from.exolix.coin,
        networkFrom: from.exolix.network,
        coinTo: to.exolix.coin,
        networkTo: to.exolix.network,
        amount: unitsToDecimal(req.from, req.pay),
        withdrawalAddress: own.withdrawal,
        refundAddress: own.refund,
        rateType: 'fixed',
      }),
    },
    opts.fetch ?? fetch,
  )
  const exchange = readExchange(body, req.from, req.to)
  if (exchange.pay !== req.pay || exchange.receive < req.receive) {
    throw new SwapRefusal(
      'terms-changed',
      `Exolix now pays ${unitsToDecimal(req.to, exchange.receive)} ${to.ticker} for ${unitsToDecimal(req.from, exchange.pay)} ${from.ticker}, not the confirmed ${unitsToDecimal(req.to, req.receive)} for ${unitsToDecimal(req.from, req.pay)}. Nothing was paid.`,
    )
  }
  if (exchange.withdrawalAddress !== own.withdrawal) {
    throw new SwapRefusal('wrong-payout', 'Exolix named a payout address that is not this wallet. Nothing was paid.')
  }
  if (!opts.validAddress(req.from, exchange.depositAddress) || exchange.depositAddress === own.refund) {
    throw new SwapRefusal('bad-deposit', `Exolix's deposit address is not a ${from.label} address. Nothing was paid.`)
  }
  return exchange
}

/** Exolix's current status for an exchange. */
export async function fetchExolixStatus(exchange: { id: string; from: SwapAsset; to: SwapAsset }, opts: { fetch?: typeof fetch } = {}): Promise<ExolixStatus> {
  const body = await exolixCall(`${EXOLIX_TX_URL}/${encodeURIComponent(exchange.id)}`, { method: 'GET' }, opts.fetch ?? fetch)
  return readExchange(body, exchange.from, exchange.to).status
}

// ── Records ────────────────────────────────────────────────────────────────

const listeners = new Set<() => void>()
const recordsKey = () => accountLocalKey(storageRegistry.swaps.key)

export function readSwapRecords(): SwapRecord[] {
  try {
    const parsed = JSON.parse(durableGetItem(recordsKey()) ?? '[]') as unknown
    return Array.isArray(parsed) ? (parsed as SwapRecord[]) : []
  } catch {
    return []
  }
}

export function writeSwapRecord(record: SwapRecord): void {
  const next = [record, ...readSwapRecords().filter((r) => r.id !== record.id)].slice(0, 50)
  if (!durableSetItem(recordsKey(), JSON.stringify(next))) throw new Error('The swap record could not be saved.')
  for (const listener of listeners) listener()
}

export function subscribeSwapRecords(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Ask Exolix about every swap it has not finished; one call per open swap. */
export async function refreshSwapRecords(opts: { fetch?: typeof fetch; now?: () => number } = {}): Promise<void> {
  const open = readSwapRecords().filter((r) => r.stage === 'paid' && !EXOLIX_FINAL.includes(r.status))
  for (const record of open) {
    try {
      const status = await fetchExolixStatus(record, opts)
      if (status !== record.status) {
        console.info(`[swap] exolix ${record.id} ${record.status} → ${status}`)
        writeSwapRecord({ ...record, status, updatedAt: (opts.now ?? Date.now)() })
      }
    } catch (err) {
      console.warn(`[swap] exolix ${record.id} status unavailable — ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
