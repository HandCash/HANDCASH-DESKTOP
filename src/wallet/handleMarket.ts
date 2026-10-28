/**
 * The handles market: buy a handle, priced by length, and have it issued to an
 * identity key this wallet signs with.
 *
 * BRC-CLOUD holds the only price list (`src/handleMarketConfig.js`) and opens
 * an order with its own pay-to address; this wallet never holds an amount of
 * its own. A purchase checks the handle rules and that the handle is free,
 * shows the quoted price in the wallet payment prompt, pays through
 * `sendSatsToAddress`, then trades the payment for a claim ticket and issues
 * the handle through `issueHandleCertificate`, the same grant and claim path
 * apps use. A paid purchase is stored until its handle is issued or BRC-CLOUD
 * owes its refund, so a reply lost after payment is resumed with the same
 * order, never paid again.
 */
import { storageRegistry } from '../storage/registry'
import { accountLocalKey } from './accountLocalKeys'
import { durableGetItem, durableSetItem } from './durableStorage'
import { HOME_HANDLE_DOMAIN } from './handleDomain'
import {
  HandleIssueError,
  parseHandleIssueScope,
  type HandleIssueRequest,
  type HandleIssueResult,
  type HandleIssueScope,
} from './handleIssuance'

/**
 * Off until handle claiming on the items market (/claim-handle) shuts down:
 * that path hands out free tickets for the same handles, so a handle paid for
 * here could be claimed from under its buyer. BRC-CLOUD's
 * HANDLE_MARKET_ENABLED must stay off for the same reason.
 */
export const HANDLE_MARKET_ENABLED = false

export const HANDLE_MARKET_MIN_LENGTH = 3
export const HANDLE_MARKET_SCOPE = 'handle-market'

const TXID_PATTERN = /^[0-9a-f]{64}$/
/** Waits between asks for a ticket once paid; the attempt count is one more. */
const FULFIL_RETRY_DELAYS_MS = [1_000, 3_000, 10_000]

export type HandleMarketOrder = {
  id: string
  handle: string
  identityKey: string
  priceSats: number
  payTo: string
  state: 'quoted' | 'paid' | 'issued' | 'refund-owed' | 'refunded' | 'expired'
  expiresAt: number
  paymentTxid?: string
  refundReason?: string
}

export type HandleMarketFulfilment = {
  order: HandleMarketOrder
  claimTicket?: string
}

export type HandlePurchase = {
  orderId: string
  handle: string
  identityKey: string
  priceSats: number
  payTo: string
  /** `paying`: the payment was started and its outcome never recorded. */
  state: 'paying' | 'paid' | 'refund-owed'
  txid?: string
  refundReason?: string
}

export type HandlePurchaseResult = {
  orderId: string
  handle: string
  identityKey: string
  priceSats: number
  txid: string
  /** Null when BRC-CLOUD already had the handle bound to this key (an earlier reply was lost). */
  issued: HandleIssueResult | null
}

export type HandleMarketErrorCode =
  | 'HANDLE_MARKET_OFF'
  | 'HANDLE_MARKET_INVALID'
  | 'HANDLE_MARKET_TOO_SHORT'
  | 'HANDLE_MARKET_WRONG_KEY'
  | 'HANDLE_MARKET_TAKEN'
  | 'HANDLE_MARKET_HELD'
  | 'HANDLE_MARKET_UNPRICED'
  | 'HANDLE_MARKET_UNAVAILABLE'
  | 'HANDLE_MARKET_REFUSED'
  | 'HANDLE_MARKET_PAYMENT_FAILED'
  | 'HANDLE_MARKET_ISSUE_PENDING'
  | 'HANDLE_MARKET_REFUND_OWED'

export class HandleMarketError extends Error {
  readonly code: HandleMarketErrorCode
  /** Set once the price has been paid. */
  readonly purchase?: HandlePurchase

  constructor(code: HandleMarketErrorCode, message: string, purchase?: HandlePurchase) {
    super(message)
    this.name = 'HandleMarketError'
    this.code = code
    if (purchase) this.purchase = purchase
  }
}

/** A refusal BRC-CLOUD answered, by its own code. */
export class HandleMarketServerError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message?: string) {
    super(message || code)
    this.name = 'HandleMarketServerError'
    this.code = code
    this.status = status
  }
}

export type HandlePurchaseStore = {
  load: () => HandlePurchase[]
  save: (purchase: HandlePurchase) => void
  remove: (orderId: string) => void
}

export type HandleMarketDeps = {
  enabled: boolean
  sleep: (ms: number) => Promise<void>
  /** The identity key the wallet signs with now, or null when locked. */
  activeIdentityKey: () => string | null
  /** The identity key holding the handle, or null when it is free. */
  holderOf: (handle: string) => Promise<string | null>
  quote: (scope: HandleIssueScope) => Promise<HandleMarketOrder>
  /** Shows the price. Nothing is paid unless this allows. */
  confirm: (order: HandleMarketOrder) => Promise<'allow' | 'deny'>
  pay: (payment: { to: string; satoshis: number; description: string }) => Promise<{ txid: string }>
  fulfil: (purchase: HandlePurchase) => Promise<HandleMarketFulfilment>
  /** Issues through the grant and claim path, already approved by `confirm`. */
  issue: (origin: string, request: HandleIssueRequest) => Promise<HandleIssueResult>
  store: HandlePurchaseStore
}

const display = (handle: string) => `@${handle}@${HOME_HANDLE_DOMAIN}`

function quoteFailure(err: unknown): HandleMarketError {
  const code = err instanceof HandleMarketServerError ? err.code : null
  switch (code) {
    case 'handle-market-off':
      return new HandleMarketError('HANDLE_MARKET_OFF', 'The handles market is not open.')
    case 'handle-too-short':
      return new HandleMarketError('HANDLE_MARKET_TOO_SHORT', `Handles are at least ${HANDLE_MARKET_MIN_LENGTH} characters.`)
    case 'handle-taken':
    case 'handle-reserved':
      return new HandleMarketError('HANDLE_MARKET_TAKEN', 'This handle is taken or being bought by someone else.')
    case 'handle-held':
      return new HandleMarketError('HANDLE_MARKET_HELD', 'This identity key already holds the handle.')
    case 'market-unpriced':
      return new HandleMarketError('HANDLE_MARKET_UNPRICED', 'Handles of this length are not for sale yet.')
    case 'wrong-identity':
      return new HandleMarketError('HANDLE_MARKET_WRONG_KEY', 'HandCash could not prove it signs with that identity key.')
    default:
      return new HandleMarketError(
        'HANDLE_MARKET_UNAVAILABLE',
        `The handles market did not answer: ${err instanceof Error ? err.message : String(err)}. Nothing was paid.`,
      )
  }
}

function sameScope(order: HandleMarketOrder, scope: HandleIssueScope): boolean {
  return (
    order.handle === scope.handle &&
    order.identityKey?.toLowerCase() === scope.identityKey &&
    order.state === 'quoted' &&
    Number.isSafeInteger(order.priceSats) &&
    order.priceSats > 0 &&
    typeof order.id === 'string' &&
    order.id.length > 0 &&
    typeof order.payTo === 'string' &&
    order.payTo.length > 0
  )
}

function assertSigningKey(deps: HandleMarketDeps, identityKey: string): void {
  if (deps.activeIdentityKey()?.toLowerCase() !== identityKey) {
    throw new HandleMarketError(
      'HANDLE_MARKET_WRONG_KEY',
      'HandCash is not signing with that identity key. Switch to the account that should own the handle.',
    )
  }
}

/** A refusal after which asking again cannot help without someone changing something. */
function isFinalServerRefusal(err: unknown): boolean {
  return (
    err instanceof HandleMarketServerError &&
    err.status >= 400 &&
    err.status < 500 &&
    err.status !== 429 &&
    err.code !== 'payment-not-found'
  )
}

/** Issuance failures the next ticket request settles: a fresh ticket, `issued`, or `refund-owed`. */
const ISSUE_RETRYABLE = new Set(['HANDLE_ISSUE_TICKET_REJECTED', 'HANDLE_ISSUE_TAKEN', 'HANDLE_ISSUE_FAILED'])

function pending(purchase: HandlePurchase, why: string): HandleMarketError {
  return new HandleMarketError(
    'HANDLE_MARKET_ISSUE_PENDING',
    `${display(purchase.handle)} is paid and not issued yet: ${why}. HandCash will finish it with the same payment.`,
    purchase,
  )
}

/**
 * Trades a paid order for its handle. Every answer either issues the handle,
 * records the refund BRC-CLOUD owes, or leaves the paid purchase stored to
 * finish later; none pays again.
 */
export async function completeHandlePurchase(
  origin: string,
  purchase: HandlePurchase,
  deps: HandleMarketDeps,
): Promise<HandlePurchaseResult> {
  if (purchase.state !== 'paid' || !purchase.txid) throw pending(purchase, 'its payment was never recorded')
  const txid = purchase.txid
  const done = (issued: HandleIssueResult | null): HandlePurchaseResult => {
    deps.store.remove(purchase.orderId)
    return { orderId: purchase.orderId, handle: purchase.handle, identityKey: purchase.identityKey, priceSats: purchase.priceSats, txid, issued }
  }

  let lastProblem = 'HandCash did not answer'
  for (let attempt = 0; attempt <= FULFIL_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await deps.sleep(FULFIL_RETRY_DELAYS_MS[attempt - 1])

    let answer: HandleMarketFulfilment
    try {
      answer = await deps.fulfil(purchase)
    } catch (err) {
      lastProblem = err instanceof Error ? err.message : String(err)
      if (isFinalServerRefusal(err)) break
      continue
    }

    const { order } = answer
    if (order.id !== purchase.orderId) {
      lastProblem = 'HandCash answered for another order'
      continue
    }
    if (order.state === 'issued') return done(null)
    if (order.state === 'refund-owed' || order.state === 'refunded') {
      const owed: HandlePurchase = { ...purchase, state: 'refund-owed', ...(order.refundReason ? { refundReason: order.refundReason } : {}) }
      deps.store.save(owed)
      throw new HandleMarketError(
        'HANDLE_MARKET_REFUND_OWED',
        `${display(purchase.handle)} could not be issued (${order.refundReason ?? 'refused'}). HandCash owes you a refund of this payment.`,
        owed,
      )
    }
    if (order.state !== 'paid' || !answer.claimTicket) {
      lastProblem = `the order is ${order.state}`
      continue
    }

    try {
      return done(
        await deps.issue(origin, { handle: purchase.handle, identityKey: purchase.identityKey, claimTicket: answer.claimTicket }),
      )
    } catch (err) {
      lastProblem = err instanceof Error ? err.message : String(err)
      if (err instanceof HandleIssueError && !ISSUE_RETRYABLE.has(err.code)) break
    }
  }
  throw pending(purchase, lastProblem)
}

export async function buyHandle(origin: string, raw: unknown, deps: HandleMarketDeps): Promise<HandlePurchaseResult> {
  if (!deps.enabled) throw new HandleMarketError('HANDLE_MARKET_OFF', 'The handles market is not open.')

  let scope: HandleIssueScope
  try {
    scope = parseHandleIssueScope(raw)
  } catch (err) {
    throw new HandleMarketError('HANDLE_MARKET_INVALID', err instanceof Error ? err.message : 'Name a valid handle.')
  }
  if (scope.handle.length < HANDLE_MARKET_MIN_LENGTH) {
    throw new HandleMarketError('HANDLE_MARKET_TOO_SHORT', `Handles are at least ${HANDLE_MARKET_MIN_LENGTH} characters.`)
  }
  assertSigningKey(deps, scope.identityKey)

  const paidBefore = deps.store
    .load()
    .find((p) => p.state === 'paid' && p.handle === scope.handle && p.identityKey === scope.identityKey)
  if (paidBefore) return completeHandlePurchase(origin, paidBefore, deps)

  let holder: string | null
  try {
    holder = await deps.holderOf(scope.handle)
  } catch (err) {
    throw quoteFailure(err)
  }
  if (holder?.toLowerCase() === scope.identityKey) {
    throw new HandleMarketError('HANDLE_MARKET_HELD', 'This identity key already holds the handle.')
  }
  if (holder) throw new HandleMarketError('HANDLE_MARKET_TAKEN', 'This handle is taken.')

  let order: HandleMarketOrder
  try {
    order = await deps.quote(scope)
  } catch (err) {
    throw quoteFailure(err)
  }
  if (!sameScope(order, scope)) {
    throw new HandleMarketError('HANDLE_MARKET_UNAVAILABLE', 'The handles market answered with a different order. Nothing was paid.')
  }

  if ((await deps.confirm(order)) !== 'allow') {
    throw new HandleMarketError('HANDLE_MARKET_REFUSED', 'You did not buy the handle. Nothing was paid.')
  }
  // The account may have changed while the prompt was open.
  assertSigningKey(deps, scope.identityKey)

  const paying: HandlePurchase = {
    orderId: order.id,
    handle: scope.handle,
    identityKey: scope.identityKey,
    priceSats: order.priceSats,
    payTo: order.payTo,
    state: 'paying',
  }
  deps.store.save(paying)
  let txid: string
  try {
    ;({ txid } = await deps.pay({ to: order.payTo, satoshis: order.priceSats, description: `HandCash handle ${display(scope.handle)}` }))
  } catch (err) {
    deps.store.remove(order.id)
    throw new HandleMarketError(
      'HANDLE_MARKET_PAYMENT_FAILED',
      `The payment did not go through, so no handle was issued: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!TXID_PATTERN.test(txid)) {
    throw pending(paying, 'the payment returned no transaction id; check Activity')
  }
  const paid: HandlePurchase = { ...paying, state: 'paid', txid }
  deps.store.save(paid)
  return completeHandlePurchase(origin, paid, deps)
}

export type HandlePurchaseOutcome =
  | { orderId: string; ok: true; result: HandlePurchaseResult }
  | { orderId: string; ok: false; error: HandleMarketError }

/** Finishes every paid purchase this account left unissued. Does nothing while the market is off. */
export async function resumeHandlePurchases(origin: string, deps: HandleMarketDeps): Promise<HandlePurchaseOutcome[]> {
  if (!deps.enabled) return []
  const outcomes: HandlePurchaseOutcome[] = []
  for (const purchase of deps.store.load()) {
    if (purchase.state !== 'paid') continue
    if (deps.activeIdentityKey()?.toLowerCase() !== purchase.identityKey) continue
    try {
      outcomes.push({ orderId: purchase.orderId, ok: true, result: await completeHandlePurchase(origin, purchase, deps) })
    } catch (err) {
      if (!(err instanceof HandleMarketError)) throw err
      outcomes.push({ orderId: purchase.orderId, ok: false, error: err })
    }
  }
  return outcomes
}

function readPurchases(key: string): HandlePurchase[] {
  try {
    const parsed: unknown = JSON.parse(durableGetItem(key) ?? '[]')
    return Array.isArray(parsed) ? (parsed as HandlePurchase[]) : []
  } catch {
    return []
  }
}

async function marketPost<T>(path: string, scope: HandleIssueScope, body: unknown): Promise<T> {
  const [{ getActiveWallet }, { signedIdentityFetch }, { DEFAULT_BRC_CLOUD_BASE_URL }] = await Promise.all([
    import('./session'),
    import('./identityRequestAuth'),
    import('./walletConfig'),
  ])
  const active = getActiveWallet()
  if (!active || active.identityKey.toLowerCase() !== scope.identityKey) {
    throw new HandleMarketServerError('wrong-identity', 403, 'HandCash is not signing with that identity key')
  }
  const url = `${DEFAULT_BRC_CLOUD_BASE_URL.replace(/\/+$/, '')}/v1/handle-market${path}`
  const res = await signedIdentityFetch(active.rootKeyHex, HANDLE_MARKET_SCOPE, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
  if (!res.ok) {
    throw new HandleMarketServerError(data?.error?.code ?? `http-${res.status}`, res.status, data?.error?.message)
  }
  return data as T
}

/** The wallet's own wiring: BRC-CLOUD, the wallet payment prompt, `sendSatsToAddress` and `issueHandleCertificate`. */
export function walletHandleMarketDeps(activeIdentityKey: () => string | null): HandleMarketDeps {
  return {
    enabled: HANDLE_MARKET_ENABLED,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    activeIdentityKey,
    holderOf: async (handle) => {
      const { HandleNotFoundError, resolveHandle } = await import('./handleResolve')
      try {
        return (await resolveHandle(handle)).identityKey.toLowerCase()
      } catch (err) {
        if (err instanceof HandleNotFoundError) return null
        throw err
      }
    },
    quote: async (scope) =>
      (await marketPost<{ order: HandleMarketOrder }>('/quote', scope, { handle: scope.handle, identityKey: scope.identityKey })).order,
    confirm: async (order) => {
      const { approveWalletPayment, WalletPaymentDenied } = await import('./permissions')
      try {
        await approveWalletPayment({
          title: 'Buy a handle',
          summary: `Buy ${display(order.handle)}`,
          amountSats: order.priceSats,
          details: [
            `Handle: ${display(order.handle)}`,
            `Owner key: ${order.identityKey.slice(0, 8)}…${order.identityKey.slice(-8)}`,
            'Issued to this key once paid; refunded if HandCash cannot issue it',
          ],
        })
        return 'allow'
      } catch (err) {
        if (err instanceof WalletPaymentDenied) return 'deny'
        throw err
      }
    },
    pay: async ({ to, satoshis, description }) => {
      const { sendSatsToAddress } = await import('./sendPayment')
      return sendSatsToAddress({ to, satoshis, description })
    },
    fulfil: (purchase) =>
      marketPost<HandleMarketFulfilment>(
        `/orders/${encodeURIComponent(purchase.orderId)}/fulfil`,
        { handle: purchase.handle, identityKey: purchase.identityKey },
        { txid: purchase.txid },
      ),
    issue: async (origin, request) => {
      const { issueHandleCertificate, walletHandleIssueDeps } = await import('./handleIssuance')
      return issueHandleCertificate(origin, request, {
        ...walletHandleIssueDeps(activeIdentityKey),
        // The price prompt named this handle and key; it is the approval.
        approve: async (_origin, scope) =>
          scope.handle === request.handle && scope.identityKey === request.identityKey ? 'allow' : 'deny',
      })
    },
    store: walletHandlePurchaseStore(),
  }
}

/** Per account, so a purchase resumes only on the account that paid for it. */
function walletHandlePurchaseStore(): HandlePurchaseStore {
  const key = () => accountLocalKey(storageRegistry.handlePurchases.key)
  const write = (purchases: HandlePurchase[]) => durableSetItem(key(), JSON.stringify(purchases))
  return {
    load: () => readPurchases(key()),
    save: (purchase) => write([...readPurchases(key()).filter((p) => p.orderId !== purchase.orderId), purchase]),
    remove: (orderId) => write(readPurchases(key()).filter((p) => p.orderId !== orderId)),
  }
}
