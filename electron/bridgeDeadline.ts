/**
 * How long the bridge waits for the renderer, per BRC-100 method.
 *
 * A read can be given up on: nothing happened, and the caller can ask again.
 * A spend cannot. `createAction` / `signAction` / `internalizeAction` sign and
 * queue a transaction, so abandoning one does not undo it — the renderer keeps
 * going and may well succeed after the HTTP call has already been answered.
 *
 * A BSV-21 mint studio run hit exactly that: the mint spent an auth tip from a
 * genesis deployed seconds earlier, proof hydration for the unmined ancestry
 * outran the flat 120s deadline, and the studio reported "mint stopped" for a
 * transaction the wallet was still building. So spends get a longer budget, and
 * when even that passes they come back as `WALLET_BRIDGE_PENDING` — "may still
 * land, go and reconcile" — never as a plain failure.
 *
 * Only methods known to change nothing may be called off as not having run.
 * Anything else, including a method added later, counts as a spend: a list of
 * spends missed `sendCoins` and the BNT asset moves, and told their callers a
 * payment that went on to land had not run.
 */

export const BRIDGE_DEADLINE_MS = 120_000
export const SPEND_DEADLINE_MS = 300_000

/** Methods that change nothing in the wallet, so a timeout means it did not run. */
const READ_METHODS = new Set(
  [
    'health',
    'getVersion',
    'getNetwork',
    'getHeight',
    'getHeaderForHeight',
    'isAuthenticated',
    'waitForAuthentication',
    'getPublicKey',
    'listActions',
    'listOutputs',
    'getBalance',
    'listCertificates',
    'proveCertificate',
    'discoverByIdentityKey',
    'discoverByAttributes',
    'revealCounterpartyKeyLinkage',
    'revealSpecificKeyLinkage',
    'encrypt',
    'decrypt',
    'createHmac',
    'verifyHmac',
    'createSignature',
    'verifySignature',
    'getLegacyAddress',
    'listMigrationTxids',
    'verifyMarketListingProvenance',
    'getMarketSettlementReceipt',
    'getMarketListingStatus',
    'listBntAssets',
    'getLtcDepositAddress',
    'listLtcDeposits',
    'getCoinAddress',
    'listCoins',
    'listAssetProfiles',
    'getClaimedCloudHandle',
    'getArcUsdAddress',
    'listArcUsd',
    'listArcUsdcWrapClaims',
    'getArcUsdcWrapSpendable',
    'planArcUsdcFractionalize',
    'planArcUsdcRedeem',
  ].map((m) => m.toLowerCase()),
)

function methodOf(path: string): string {
  return path.trim().toLowerCase().replace(/^\/+/, '').replace(/\/+$/, '')
}

export function isSpendMethodPath(path: string): boolean {
  return !READ_METHODS.has(methodOf(path))
}

export function bridgeDeadlineMs(path: string): number {
  return isSpendMethodPath(path) ? SPEND_DEADLINE_MS : BRIDGE_DEADLINE_MS
}

/**
 * `WALLET_BRIDGE_PENDING` tells a client the wallet may still complete the
 * action; `WALLET_BRIDGE_TIMEOUT` means it can be treated as not having run.
 */
export function bridgeDeadlineCode(
  path: string,
): 'WALLET_BRIDGE_PENDING' | 'WALLET_BRIDGE_TIMEOUT' {
  return isSpendMethodPath(path) ? 'WALLET_BRIDGE_PENDING' : 'WALLET_BRIDGE_TIMEOUT'
}

export function bridgeDeadlineMessage(method: string, path: string): string {
  const code = bridgeDeadlineCode(path)
  const ms = bridgeDeadlineMs(path)
  return code === 'WALLET_BRIDGE_PENDING'
    ? `WALLET_BRIDGE_PENDING: ${method} ${path} is still running in the wallet after ${ms}ms — it may still complete; reconcile before retrying`
    : `WALLET_BRIDGE_TIMEOUT: no renderer reply for ${method} ${path} within ${ms}ms`
}
