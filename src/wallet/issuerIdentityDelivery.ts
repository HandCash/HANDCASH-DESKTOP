import type { ChainTracker } from '@bsv/sdk'
import { Beef } from '@bsv/sdk'
import { base64ToBytes } from './base64Binary'
import { retainedIssuerMetadata } from './issuerAttribution'
import { issuerIdentityPackage, rememberConfirmedIssuerIdentityPackage } from './issuerIdentities'
import type { IssuerIdentityPackage } from './issuerIdentity'
import { issuerMetadataFromScript } from './issuerMetadata'
import { parseProvenanceV2 } from './oneSatProvenance'
import type { Chain } from './vault'

/**
 * Identity packages ride beside an item delivery, once per envelope, and are
 * stored once per BAP ID on arrival. The item itself carries only the BAP ID
 * inside its Sigma-signed tape.
 */
export const MAX_ENVELOPE_IDENTITIES = 2

function bapIdFromProvenance(raw: unknown): string | null {
  const proof = parseProvenanceV2(raw)
  if (!proof) return null
  const match = /^([0-9a-f]{64})_(\d+)$/i.exec(proof.origin)
  if (!match) return null
  try {
    const tx = Beef.fromBinary(Array.from(base64ToBytes(proof.beefB64))).findTxid(match[1]!.toLowerCase())?.tx
    return issuerMetadataFromScript(tx?.outputs[Number(match[2])]?.lockingScript.toHex()).bapId ?? null
  } catch {
    return null
  }
}

/** Packages for the identities the delivered asset's origin names. */
export function identityPackagesForDelivery(
  chain: Chain,
  subject: { itemOrigin?: string; tokenId?: string; provenance?: unknown },
): IssuerIdentityPackage[] {
  const ids = new Set<string>()
  for (const origin of [subject.itemOrigin, subject.tokenId]) {
    const bapId = origin ? retainedIssuerMetadata(origin)?.bapId : undefined
    if (bapId) ids.add(bapId)
  }
  if (!ids.size) {
    const bapId = bapIdFromProvenance(subject.provenance)
    if (bapId) ids.add(bapId)
  }
  const packages: IssuerIdentityPackage[] = []
  for (const bapId of ids) {
    const pkg = issuerIdentityPackage(chain, bapId)
    if (pkg) packages.push(pkg)
    if (packages.length >= MAX_ENVELOPE_IDENTITIES) break
  }
  return packages
}

/** Verify, header-check and store identity packages from an inbound envelope. */
export async function rememberDeliveredIdentities(
  chain: Chain,
  raw: unknown,
  tracker: ChainTracker | null | undefined,
): Promise<number> {
  if (!Array.isArray(raw)) return 0
  let stored = 0
  for (const pkg of raw.slice(0, MAX_ENVELOPE_IDENTITIES))
    if (await rememberConfirmedIssuerIdentityPackage(chain, pkg, tracker)) stored++
  return stored
}
