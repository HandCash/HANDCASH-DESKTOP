import { isSpendMethodPath } from './bridgeDeadline.js'

/**
 * BRC-326 Wallet Failure Presentation: every error the bridge answers carries
 * `class`, `fault` and `retry` beside BRC-100's `{status, code, description}`,
 * so an app can say what happened, whose doing it was and whether trying again
 * is safe without matching on our codes or wording.
 *
 * The rule that matters most is `uncertain-delivery`: wherever the wallet
 * cannot prove a request did not take effect, it says so, and never reports a
 * clean failure an app would answer with a second payment.
 */

export type FailureClass =
  | 'insufficient-funds'
  | 'locked'
  | 'permission-denied'
  | 'policy-blocked'
  | 'unreachable'
  | 'invalid-request'
  | 'uncertain-delivery'
  | 'unavailable'

export type FailureFault = 'user' | 'application' | 'wallet' | 'counterparty' | 'network' | 'none'
export type FailureRetry = 'safe' | 'unsafe' | 'check-first'

export type WalletFailure = { class: FailureClass; fault: FailureFault; retry: FailureRetry }

const INSUFFICIENT: WalletFailure = { class: 'insufficient-funds', fault: 'none', retry: 'check-first' }
const LOCKED: WalletFailure = { class: 'locked', fault: 'none', retry: 'safe' }
const DENIED: WalletFailure = { class: 'permission-denied', fault: 'user', retry: 'unsafe' }
const POLICY: WalletFailure = { class: 'policy-blocked', fault: 'none', retry: 'unsafe' }
const UNREACHABLE: WalletFailure = { class: 'unreachable', fault: 'none', retry: 'safe' }
const INVALID: WalletFailure = { class: 'invalid-request', fault: 'application', retry: 'unsafe' }
const UNCERTAIN: WalletFailure = { class: 'uncertain-delivery', fault: 'none', retry: 'check-first' }
const LATER: WalletFailure = { class: 'unavailable', fault: 'wallet', retry: 'safe' }
const NOT_HERE: WalletFailure = { class: 'unavailable', fault: 'wallet', retry: 'unsafe' }
const CHECK: WalletFailure = { class: 'unavailable', fault: 'wallet', retry: 'check-first' }

/**
 * Codes whose class holds on any method. A code missing here is an unknown
 * failure: on a method that may move money it is `uncertain-delivery`.
 */
const BY_CODE: Record<string, WalletFailure> = {
  INSUFFICIENT_FUNDS: INSUFFICIENT,

  WALLET_LOCKED: LOCKED,
  NOT_AUTHENTICATED: LOCKED,

  PERMISSION_DENIED: DENIED,
  ACTION_DENIED: DENIED,
  TOKEN_VIEW_DENIED: DENIED,
  ITEM_VIEW_DENIED: DENIED,
  COUNTERSIGNED_VIEW_DENIED: DENIED,

  ORIGIN_REFUSED: POLICY,
  MARKET_ORIGIN_DENIED: POLICY,
  MIGRATION_ORIGIN_DENIED: POLICY,
  PROTOCOL_REFUSE: POLICY,
  RESERVED_KEY: POLICY,
  ORIGIN_BOUND_IN_APP: POLICY,

  WALLET_BRIDGE_UNAVAILABLE: UNREACHABLE,

  BAD_REQUEST: INVALID,
  BODY_TOO_LARGE: INVALID,
  INVALID_SATOSHIS: INVALID,
  INVALID_TOKEN_SCOPE: INVALID,
  INVALID_P1SAT_SCOPE: INVALID,
  INVALID_COUNTERSIGNED_SCOPE: INVALID,
  INVALID_IDENTITY_PROOF: INVALID,
  MISSING_TOKEN_SCOPE_TAG: INVALID,
  MISSING_P1SAT_SCOPE_TAG: INVALID,
  MISSING_COUNTERSIGNED_SCOPE_TAG: INVALID,
  USE_TOKEN_SCOPE: INVALID,
  USE_P1SAT_SCOPE: INVALID,
  USE_COUNTERSIGNED_SCOPE: INVALID,
  UNSUPPORTED_P_BASKET: INVALID,
  EMPTY_INPUTS: INVALID,
  DUST_OUTPUT: INVALID,
  COIN_OWN_ADDRESS: INVALID,

  WALLET_BRIDGE_PENDING: UNCERTAIN,
  ACTION_IN_PROGRESS: UNCERTAIN,
  // The spend region was freed while the wallet engine still held the call, which may yet broadcast.
  SPEND_REGION_ABANDONED: UNCERTAIN,
  // The catch-all for a spend that threw: nothing shows it stopped before broadcast.
  INSUFFICIENT_OR_STALE_FUNDS: UNCERTAIN,

  WALLET_BRIDGE_TIMEOUT: LATER,
  WALLET_BALANCE_TIMEOUT: LATER,
  INPUTS_UNVERIFIED: LATER,
  OFFLINE_PAYMENTS_DISABLED: LATER,
  CHANGE_CHAINING_REQUIRED: LATER,
  SPENDING_BUDGET_UNAVAILABLE: LATER,

  UNIMPLEMENTED: NOT_HERE,
  INDEX_EXPANSION_UNAVAILABLE: NOT_HERE,
  ASSET_PROTOCOL_RETIRED: NOT_HERE,
  COIN_UNSUPPORTED_CHAIN: NOT_HERE,
  BNT_WALLET_ONLY: NOT_HERE,
  COUNTERSIGNED_WALLET_ONLY: NOT_HERE,
  MARKET_LISTING_REFUSED: NOT_HERE,
  ITEM_ORIGIN_UNPROVEN: NOT_HERE,
  BEEF_ANCESTRY_INCOMPLETE: NOT_HERE,
  FEE_TOO_LOW: NOT_HERE,
  ARCADE_HARD_REJECT: NOT_HERE,

  // The inputs are gone, possibly to an earlier run of this same payment.
  DOUBLE_SPENT: CHECK,
}

const FAILURE_CLASSES = new Set<string>([
  'insufficient-funds',
  'locked',
  'permission-denied',
  'policy-blocked',
  'unreachable',
  'invalid-request',
  'uncertain-delivery',
  'unavailable',
])

export function walletFailureFor(code: unknown, status: number, path: string): WalletFailure {
  const known = typeof code === 'string' ? BY_CODE[code] : undefined
  if (known) return known
  if (status === 404) return INVALID
  return isSpendMethodPath(path) ? UNCERTAIN : LATER
}

/**
 * Add the BRC-326 fields to an error body that lacks them. A success, a body
 * that is not a JSON object, or one that already names a class passes as is.
 */
export function withWalletFailure(status: number, body: string, path: string): string {
  if (status < 400) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body
  const error = parsed as Record<string, unknown>
  if (typeof error.class === 'string' && FAILURE_CLASSES.has(error.class)) return body
  const failure = walletFailureFor(error.code, status, path)
  return JSON.stringify({ status: 'error', ...error, ...failure })
}

const UNREACHABLE_REASONS: Array<[string, string]> = [
  ['app-quitting', 'HandCash is closing. Try again once it is open.'],
  ['window-unavailable', 'HandCash could not open its window. Try again in a moment.'],
  ['renderer-not-ready', 'HandCash is still starting. Try again in a moment.'],
]

/**
 * The words an app may show for a failure the bridge itself produced. The raw
 * message names methods, paths and timings, which BRC-326 keeps out of the
 * `description`; the log keeps the raw message.
 */
export function bridgeFailureDescription(code: string, message: string, path: string): string {
  if (code === 'WALLET_BRIDGE_UNAVAILABLE') {
    for (const [reason, words] of UNREACHABLE_REASONS) {
      if (message.includes(reason)) return words
    }
    return 'HandCash could not be reached just now. Try again in a moment.'
  }
  if (code === 'WALLET_BRIDGE_TIMEOUT') {
    return 'HandCash took too long to answer and nothing changed. Try again in a moment.'
  }
  if (code === 'WALLET_BRIDGE_PENDING' || isSpendMethodPath(path)) {
    return 'HandCash may still finish this. Check your balance and activity before trying again.'
  }
  return 'HandCash could not finish this request. Try again in a moment.'
}
