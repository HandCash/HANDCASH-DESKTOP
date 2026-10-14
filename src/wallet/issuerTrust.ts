/**
 * What lets a person tell one profile from a look-alike.
 *
 * A name and image are whatever the profile's owner chose, so anyone can
 * publish "HandCash" with HandCash's logo. Three facts separate them:
 *  - the profile ID itself (the identity key for an identity key's own
 *    profile, the BAP ID for a BAP profile), shown short beside the name with
 *    an identicon drawn from its hash, so two profiles never look the same at
 *    a glance;
 *  - HandCash's signed verified-issuer list (`verifiedIssuers.ts`);
 *  - a name that reads like a listed issuer's, or like another profile this
 *    device holds, while the ID differs.
 */
import { Hash, Utils } from '@bsv/sdk'

export type VerifiedIssuer = { bapId: string; name: string }

export type IssuerNameCaution =
  /** Reads like a HandCash-verified issuer's name, under another ID. */
  | { kind: 'imitates-listed'; listed: VerifiedIssuer }
  /** Another profile on this device reads the same. */
  | { kind: 'shared-name'; others: number }

export type IssuerTrust = {
  listed(id: string): VerifiedIssuer | null
  caution(id: string, name: string): IssuerNameCaution | null
}

export const NO_ISSUER_TRUST: IssuerTrust = { listed: () => null, caution: () => null }

const CONFUSABLES: ReadonlyArray<[RegExp, string]> = [
  [/rn/g, 'm'],
  [/vv/g, 'w'],
  [/0/g, 'o'],
  [/[1il|]/g, 'l'],
  [/3/g, 'e'],
  [/5/g, 's'],
  [/\$/g, 's'],
  [/@/g, 'a'],
]

/** How a name reads: case, accents, spacing, punctuation and common look-alikes folded away. */
export function identityNameSkeleton(name: string): string {
  let s = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  for (const [pattern, replacement] of CONFUSABLES) s = s.replace(pattern, replacement)
  return s.replace(/[^\p{L}\p{N}]/gu, '')
}

export function issuerTrustFrom(args: {
  listed: (id: string) => VerifiedIssuer | null
  listedEntries: readonly VerifiedIssuer[]
  storedIdentities: () => ReadonlyArray<{ id: string; name: string }>
}): IssuerTrust {
  let listedBySkeleton: Map<string, VerifiedIssuer> | undefined
  let storedBySkeleton: Map<string, Set<string>> | undefined
  return {
    listed: args.listed,
    caution(id, name) {
      if (args.listed(id)) return null
      const skeleton = identityNameSkeleton(name)
      if (!skeleton) return null
      listedBySkeleton ??= new Map(args.listedEntries.map((e) => [identityNameSkeleton(e.name), e]))
      const listed = listedBySkeleton.get(skeleton)
      if (listed) return { kind: 'imitates-listed', listed }
      if (!storedBySkeleton) {
        storedBySkeleton = new Map()
        for (const identity of args.storedIdentities()) {
          const key = identityNameSkeleton(identity.name)
          const ids = storedBySkeleton.get(key) ?? new Set<string>()
          ids.add(identity.id)
          storedBySkeleton.set(key, ids)
        }
      }
      const others = [...(storedBySkeleton.get(skeleton) ?? [])].filter((other) => other !== id).length
      return others > 0 ? { kind: 'shared-name', others } : null
    },
  }
}

export type ProfileFingerprint = {
  /** Profile ID shortened for a line of text; the full ID stays one copy away. */
  short: string
  /** Hue of the identicon, 0–359. */
  hue: number
  /** 5×5 identicon, row-major, mirrored left to right. */
  cells: boolean[]
}

const fingerprints = new Map<string, ProfileFingerprint>()

export function profileFingerprint(id: string): ProfileFingerprint {
  const cached = fingerprints.get(id)
  if (cached) return cached
  const digest = Hash.sha256(Utils.toArray(id, 'utf8'))
  const bit = (i: number) => ((digest[1 + (i >> 3)]! >> (i & 7)) & 1) === 1
  const cells: boolean[] = []
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 5; col++) cells.push(bit(row * 3 + Math.min(col, 4 - col)))
  const fingerprint = {
    short: id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id,
    hue: Math.round((digest[0]! / 256) * 360),
    cells,
  }
  if (fingerprints.size >= 512) fingerprints.clear()
  fingerprints.set(id, fingerprint)
  return fingerprint
}
