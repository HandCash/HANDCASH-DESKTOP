/**
 * What lets a person tell one BAP identity from a look-alike.
 *
 * A name and image are whatever the identity's owner chose, so anyone can
 * publish "HandCash" with HandCash's logo. Three facts separate them:
 *  - the BAP ID itself, shown short beside the name with an identicon drawn
 *    from its hash, so two identities never look the same at a glance;
 *  - HandCash's signed verified-issuer list (`verifiedIssuers.ts`);
 *  - a name that reads like a listed issuer's, or like another identity this
 *    device holds, while the BAP ID differs.
 */
import { Hash, Utils } from '@bsv/sdk'

export type VerifiedIssuer = { bapId: string; name: string }

export type IssuerNameCaution =
  /** Reads like a HandCash-verified issuer's name, under another BAP ID. */
  | { kind: 'imitates-listed'; listed: VerifiedIssuer }
  /** Another identity on this device reads the same. */
  | { kind: 'shared-name'; others: number }

export type IssuerTrust = {
  listed(bapId: string): VerifiedIssuer | null
  caution(bapId: string, name: string): IssuerNameCaution | null
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
  listed: (bapId: string) => VerifiedIssuer | null
  listedEntries: readonly VerifiedIssuer[]
  storedIdentities: () => ReadonlyArray<{ bapId: string; name: string }>
}): IssuerTrust {
  let listedBySkeleton: Map<string, VerifiedIssuer> | undefined
  let storedBySkeleton: Map<string, Set<string>> | undefined
  return {
    listed: args.listed,
    caution(bapId, name) {
      if (args.listed(bapId)) return null
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
          ids.add(identity.bapId)
          storedBySkeleton.set(key, ids)
        }
      }
      const others = [...(storedBySkeleton.get(skeleton) ?? [])].filter((id) => id !== bapId).length
      return others > 0 ? { kind: 'shared-name', others } : null
    },
  }
}

export type BapFingerprint = {
  /** BAP ID shortened for a line of text; the full ID stays one copy away. */
  short: string
  /** Hue of the identicon, 0–359. */
  hue: number
  /** 5×5 identicon, row-major, mirrored left to right. */
  cells: boolean[]
}

const fingerprints = new Map<string, BapFingerprint>()

export function bapFingerprint(bapId: string): BapFingerprint {
  const cached = fingerprints.get(bapId)
  if (cached) return cached
  const digest = Hash.sha256(Utils.toArray(bapId, 'utf8'))
  const bit = (i: number) => ((digest[1 + (i >> 3)]! >> (i & 7)) & 1) === 1
  const cells: boolean[] = []
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 5; col++) cells.push(bit(row * 3 + Math.min(col, 4 - col)))
  const fingerprint = {
    short: bapId.length > 12 ? `${bapId.slice(0, 6)}…${bapId.slice(-4)}` : bapId,
    hue: Math.round((digest[0]! / 256) * 360),
    cells,
  }
  if (fingerprints.size >= 512) fingerprints.clear()
  fingerprints.set(bapId, fingerprint)
  return fingerprint
}
