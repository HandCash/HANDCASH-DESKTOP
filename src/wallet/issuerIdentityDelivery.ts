import type { ChainTracker } from '@bsv/sdk'
import { Beef } from '@bsv/sdk'
import { base64ToBytes } from './base64Binary'
import { identityKeyPackage, parseIdentityKeyPackage, type DeliveredIdentityPackage } from './identityProfile'
import { identityProfileRecord } from './identityProfiles'
import { retainedIssuerMetadata, type RetainedIssuer } from './issuerAttribution'
import {
  issuerIdentityPackage,
  linkedIssuerIdentity,
  rememberConfirmedIssuerIdentityPackage,
  rememberIdentityKeyPackage,
} from './issuerIdentities'
import { issuerMetadataFromScript } from './issuerMetadata'
import { parseProvenanceV2 } from './oneSatProvenance'
import type { Chain } from './vault'

/**
 * Identity packages ride beside an item delivery, once per envelope (BRC-248
 * §9). An identity-key stamp gets a v2 package: the key's own signed profile
 * and image, plus its linked BAP profile when both fit. A BAP stamp an earlier
 * draft wrote gets its v1 package, which older receivers still read.
 */
export const MAX_ENVELOPE_IDENTITIES = 2

function stampFromProvenance(raw: unknown): RetainedIssuer | null {
  const proof = parseProvenanceV2(raw)
  if (!proof) return null
  const match = /^([0-9a-f]{64})_(\d+)$/i.exec(proof.origin)
  if (!match) return null
  try {
    const tx = Beef.fromBinary(Array.from(base64ToBytes(proof.beefB64))).findTxid(match[1]!.toLowerCase())?.tx
    return issuerMetadataFromScript(tx?.outputs[Number(match[2])]?.lockingScript.toHex())
  } catch {
    return null
  }
}

function packageForStamp(chain: Chain, stamp: RetainedIssuer): DeliveredIdentityPackage | null {
  const issuer = stamp.issuer!
  if (stamp.bapId) return issuerIdentityPackage(chain, stamp.bapId)
  const linked = linkedIssuerIdentity(chain, issuer)
  const bap = linked ? issuerIdentityPackage(chain, linked.bapId) : null
  return identityKeyPackage(issuer, {
    profile: identityProfileRecord(chain, issuer),
    bap: bap ? { bapId: bap.bapId, beefB64: bap.beefB64 } : null,
  })
}

/** Packages for the identities the delivered asset's origin names. */
export function identityPackagesForDelivery(
  chain: Chain,
  subject: { itemOrigin?: string; tokenId?: string; provenance?: unknown },
): DeliveredIdentityPackage[] {
  const stamps: RetainedIssuer[] = []
  for (const origin of [subject.itemOrigin, subject.tokenId]) {
    const stamp = origin ? retainedIssuerMetadata(origin) : null
    if (stamp?.issuer) stamps.push(stamp)
  }
  if (!stamps.length) {
    const stamp = stampFromProvenance(subject.provenance)
    if (stamp?.issuer) stamps.push(stamp)
  }
  const packages: DeliveredIdentityPackage[] = []
  const carried = new Set<string>()
  for (const stamp of stamps) {
    if (packages.length >= MAX_ENVELOPE_IDENTITIES) break
    const name = stamp.bapId ?? stamp.issuer!
    if (carried.has(name)) continue
    const pkg = packageForStamp(chain, stamp)
    if (!pkg) continue
    carried.add(name)
    packages.push(pkg)
  }
  return packages
}

/**
 * Verify and store identity packages from an inbound envelope: a v2 package
 * through `rememberIdentityKeyPackage`, a v1 BAP package header-checked.
 */
export async function rememberDeliveredIdentities(
  chain: Chain,
  raw: unknown,
  tracker: ChainTracker | null | undefined,
): Promise<number> {
  if (!Array.isArray(raw)) return 0
  let stored = 0
  for (const entry of raw.slice(0, MAX_ENVELOPE_IDENTITIES)) {
    const kept = parseIdentityKeyPackage(entry)
      ? await rememberIdentityKeyPackage(chain, entry, tracker)
      : await rememberConfirmedIssuerIdentityPackage(chain, entry, tracker)
    if (kept) stored++
  }
  return stored
}
