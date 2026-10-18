import { KeyDeriver, PrivateKey, PublicKey, Utils, type WalletProtocol } from '@bsv/sdk'
import type { Remittance } from './brc29Keys'

/**
 * The `p color` children earlier releases wrote token and holder outputs to.
 * Spend, receive and finish in-flight transfers only: outputs already held
 * stay spendable, nothing new is locked here. A BRC-100 wallet refuses
 * `p <scheme>` protocols it does not implement (BRC-98), so these keys never
 * left this wallet. New outputs use `brc29Keys`.
 */

export const LEGACY_COLOR_KEY_ID = 'color'
const ASSET_RE = /^([0-9a-f]{64})_(0|[1-9]\d*)$/

function utf8Hex(value: string): string {
  return Utils.toHex(Utils.toArray(value, 'utf8'))
}

export function legacyColorProtocol(assetId: string, derivationPrefix: string, derivationSuffix: string): WalletProtocol {
  let tag = 'issue'
  if (assetId !== 'ISSUE') {
    const match = ASSET_RE.exec(assetId.trim().toLowerCase().replace('.', '_'))
    if (!match) throw new Error(`Invalid asset id for a legacy key: ${assetId}`)
    tag = `${match[1]}v${match[2]}`
  }
  return [2, `p color ${tag} ${utf8Hex(derivationPrefix)} ${utf8Hex(derivationSuffix)}`]
}

export function legacyColorPublicKey(
  root: PrivateKey,
  assetId: string,
  derivationPrefix: string,
  derivationSuffix: string,
  counterparty: string,
): PublicKey {
  return new KeyDeriver(root).derivePublicKey(
    legacyColorProtocol(assetId, derivationPrefix, derivationSuffix),
    LEGACY_COLOR_KEY_ID,
    counterparty,
  )
}

export function legacyColorPrivateKey(root: PrivateKey, assetId: string, remittance: Remittance): PrivateKey {
  return new KeyDeriver(root).derivePrivateKey(
    legacyColorProtocol(assetId, remittance.derivationPrefix, remittance.derivationSuffix),
    LEGACY_COLOR_KEY_ID,
    remittance.senderIdentityKey,
  )
}
