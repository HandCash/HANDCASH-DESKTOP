/**
 * HandCash handle → Issuer-Permissioned Token (IPT).
 *
 * Product rule: a claimed `$handle` is a supply-1 `iptnft` (BRC-214 / BRC-253),
 * not a free-floating name and never a BNT (`bntnft`). The issuer is the
 * BRC-169 handle certifier for the handle's domain. Transfers need that
 * issuer's countersignature — that is what makes it permissioned.
 *
 * Today the wallet holds the binding as a BRC-52 handle certificate
 * (`handleClaim.ts`). On-chain `iptnft` deploy / transfer waits on
 * countersigned mode (`bnt-tokens.md` phase 4). This module is the named
 * bridge so Identity and Collect never pretend a handle is open BNT or a
 * plain string once that engine lands.
 */
import { HOME_HANDLE_DOMAIN } from './handleDomain'
import { normalizeHandleName } from './handleFormat'
import type { ClaimedHandleState } from './handleClaim'

/** BRC-214 profile id for a handle tip. */
export const HANDLE_IPT_PROFILE = 'iptnft' as const

/** Filing basket prefix for handle IPTs once countersigned mode ships. */
export const HANDLE_IPT_BASKET = 'p iptnft' as const

export type HandleIptView = {
  profile: typeof HANDLE_IPT_PROFILE
  /** Short product form, e.g. `$alice`. */
  label: string
  handle: string
  domain: string
  identityKey: string
  /**
   * `certificate` — BRC-169 cert held locally (current).
   * `tip` — reserved for a filed `iptnft` outpoint (phase 4).
   * `empty` — no claim.
   */
  state: 'certificate' | 'tip' | 'empty'
  /** Present when a local certificate binds the name. */
  claimedAt?: number
}

/** Project a claimed handle into the IPT view model Identity / Collect use. */
export function handleIptFromClaim(
  claimed: ClaimedHandleState | null,
  displayLabel: string | null,
): HandleIptView {
  if (!claimed) {
    return {
      profile: HANDLE_IPT_PROFILE,
      label: '',
      handle: '',
      domain: HOME_HANDLE_DOMAIN,
      identityKey: '',
      state: 'empty',
    }
  }
  return {
    profile: HANDLE_IPT_PROFILE,
    label: displayLabel || `$${normalizeHandleName(claimed.handle)}`,
    handle: normalizeHandleName(claimed.handle),
    domain: HOME_HANDLE_DOMAIN,
    identityKey: claimed.identityKey,
    state: 'certificate',
    claimedAt: claimed.claimedAt,
  }
}
