/**
 * BRC-140 — Threshold key sharing via Shamir's Secret Sharing.
 * @see https://bsv.brc.dev/key-derivation/0140.md
 *
 * Uses @bsv/sdk PrivateKey.toBackupShares / fromBackupShares (reference impl).
 * Cloud providers (Google / Apple / Dropbox) are transport only — share text is the BRC.
 *
 * The integrity tag names the key, not the split: every split of one wallet
 * carries the same tag, and BRC-140 makes each split random. Two slices from
 * different splits therefore pass the per-share tag check and reconstruct the
 * wrong key. Recovery searches every pair the holder supplies and names that
 * case instead of surfacing the SDK's bare "Integrity hash mismatch".
 */
import {
  BigNumber,
  Curve,
  Hash,
  KeyShares,
  PointInFiniteField,
  Polynomial,
  PrivateKey,
  Random,
} from '@bsv/sdk'

export const BRC140_DEFAULT_THRESHOLD = 2
export const BRC140_DEFAULT_TOTAL = 3
/** Slices searched at recovery; pairs grow quadratically, so stay bounded. */
export const BRC140_MAX_RECOVERY_SHARES = 16

export type Brc140ShareSet = {
  threshold: number
  totalShares: number
  /** Canonical BRC-140 backup strings (`x.y.threshold.integrity`). */
  shares: string[]
  /** Shared 8-hex integrity tag from HASH160(compressed pubkey). */
  integrity: string
}

export type Brc140RecoveryFailure =
  | 'too-few'
  | 'same-slice'
  | 'mixed-wallets'
  | 'mixed-sets'

export class Brc140RecoveryError extends Error {
  readonly reason: Brc140RecoveryFailure
  constructor(reason: Brc140RecoveryFailure, message: string) {
    super(message)
    this.name = 'Brc140RecoveryError'
    this.reason = reason
  }
}

const SHARE_TOKEN_RE =
  /(?<![1-9A-HJ-NP-Za-km-z.])[1-9A-HJ-NP-Za-km-z]{1,64}\.[1-9A-HJ-NP-Za-km-z]{1,64}\.\d{1,3}\.[0-9a-f]{8}(?![0-9A-Za-z.])/g

export function isBrc140ShareFormat(line: string): boolean {
  const parts = line.trim().split('.')
  if (parts.length !== 4) return false
  const [x, y, t, integrity] = parts
  if (!x || !y || !integrity) return false
  if (!/^[0-9a-f]{8}$/i.test(integrity)) return false
  const threshold = Number.parseInt(t!, 10)
  return Number.isInteger(threshold) && threshold >= 2
}

/**
 * Every distinct BRC-140 share in free text — a pasted email body, a slice
 * file with `#` notes, or several slices one per line.
 */
export function extractBrc140Shares(text: string): string[] {
  const found: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue
    for (const match of line.matchAll(SHARE_TOKEN_RE)) {
      const share = match[0]
      if (isBrc140ShareFormat(share) && !found.includes(share)) found.push(share)
    }
  }
  return found
}

/** Split the vault root private key into BRC-140 backup shares. */
export function createBrc140Shares(
  rootKeyHex: string,
  threshold: number = BRC140_DEFAULT_THRESHOLD,
  totalShares: number = BRC140_DEFAULT_TOTAL,
): Brc140ShareSet {
  const key = PrivateKey.fromHex(rootKeyHex.trim())
  const shares = key.toBackupShares(threshold, totalShares)
  const integrity = shares[0]?.split('.')[3]
  if (!integrity) throw new Error('Failed to create BRC-140 shares')
  return { threshold, totalShares, shares, integrity }
}

function shareField(share: string, index: 2 | 3): string {
  return share.split('.')[index]!
}

function shareX(share: string): string {
  return share.split('.')[0]!
}

function* combinations(n: number, k: number): Generator<number[]> {
  const pick = Array.from({ length: k }, (_, i) => i)
  while (true) {
    yield pick.slice()
    let i = k - 1
    while (i >= 0 && pick[i] === n - k + i) i--
    if (i < 0) return
    pick[i]!++
    for (let j = i + 1; j < k; j++) pick[j] = pick[j - 1]! + 1
  }
}

/**
 * Recover the root private key from any number of BRC-140 slices.
 *
 * Slices are grouped by wallet (integrity + threshold); within a group every
 * `threshold`-sized combination is tried until one reconstructs the tagged
 * key. `sharesUsed` is every supplied slice that lies on the recovered split.
 */
export function recoverRootKeyFromBrc140Shares(input: string[]): {
  rootKeyHex: string
  identityKey: string
  address: string
  integrity: string
  threshold: number
  sharesUsed: string[]
} {
  const shares = extractBrc140Shares(input.join('\n'))
  if (shares.length < 2) {
    throw new Brc140RecoveryError(
      'too-few',
      shares.length === 1
        ? 'Only one key slice found. Add a second slice from the same set.'
        : 'No key slices found. Paste each slice on its own line.',
    )
  }
  if (shares.length > BRC140_MAX_RECOVERY_SHARES) {
    throw new Brc140RecoveryError(
      'too-few',
      `Paste at most ${BRC140_MAX_RECOVERY_SHARES} key slices at a time.`,
    )
  }

  const groups = new Map<string, string[]>()
  for (const share of shares) {
    const group = `${shareField(share, 3)}.${shareField(share, 2)}`
    groups.set(group, [...(groups.get(group) ?? []), share])
  }

  let triedAnyPair = false
  for (const group of groups.values()) {
    const threshold = Number.parseInt(shareField(group[0]!, 2), 10)
    const distinct = group.filter(
      (share, i) => group.findIndex((other) => shareX(other) === shareX(share)) === i,
    )
    if (distinct.length < threshold) continue
    triedAnyPair = true
    for (const pick of combinations(distinct.length, threshold)) {
      let key: PrivateKey
      try {
        key = PrivateKey.fromBackupShares(pick.map((i) => distinct[i]!))
      } catch {
        continue
      }
      const recovered = KeyShares.fromBackupFormat(pick.map((i) => distinct[i]!))
      const poly = new Polynomial(recovered.points, threshold)
      const sharesUsed = distinct.filter((share) => {
        const point = KeyShares.fromBackupFormat([share]).points[0]!
        return poly.valueAt(point.x).eq(point.y)
      })
      return {
        rootKeyHex: key.toHex(),
        identityKey: key.toPublicKey().toString(),
        address: key.toAddress(),
        integrity: recovered.integrity,
        threshold,
        sharesUsed,
      }
    }
  }

  if (!triedAnyPair) {
    if (groups.size === 1) {
      throw new Brc140RecoveryError(
        'same-slice',
        'These are copies of the same key slice. Add a different slice from the same set.',
      )
    }
    throw new Brc140RecoveryError(
      'mixed-wallets',
      `These slices belong to different wallets (integrity ${[...groups.keys()]
        .map((g) => g.split('.')[0])
        .join(', ')}). Use slices that show the same integrity tag.`,
    )
  }
  throw new Brc140RecoveryError(
    'mixed-sets',
    'These slices are from the same wallet but from different slice sets, so no two of them fit together. ' +
      'Each time slices were shown, older HandCash versions made a fresh set with the same integrity tag. ' +
      'Paste every slice you saved — HandCash tries each pair — or restore with your recovery phrase.',
  )
}

/**
 * Re-issue a full set on the split the holder recovered from.
 *
 * `sharesUsed` fix the polynomial, so new slices land on it: the holder's
 * existing slices — including any they kept but did not paste — still
 * combine with every slice in the returned set.
 */
export function extendBrc140Shares(
  rootKeyHex: string,
  sharesUsed: string[],
  totalShares: number = BRC140_DEFAULT_TOTAL,
): Brc140ShareSet {
  const key = PrivateKey.fromHex(rootKeyHex.trim())
  const parsed = KeyShares.fromBackupFormat(sharesUsed)
  const { threshold, integrity } = parsed
  if (PrivateKey.fromKeyShares(parsed).toHex() !== key.toHex()) {
    throw new Error('Slices do not reconstruct this wallet')
  }
  const poly = new Polynomial(parsed.points.slice(0, threshold), threshold)
  const points = parsed.points.slice()
  const used = new Set(points.map((p) => p.x.toString()))
  const P = new Curve().p
  const seed = Random(64)
  for (let i = points.length; i < Math.max(totalShares, points.length); i++) {
    let x: BigNumber
    let attempts = 0
    do {
      if (attempts++ >= 5) throw new Error('Failed to generate a unique slice coordinate')
      x = new BigNumber(Hash.sha512hmac(seed, [i, attempts, ...Random(32)])).umod(P)
    } while (x.isZero() || used.has(x.toString()))
    used.add(x.toString())
    points.push(new PointInFiniteField(x, poly.valueAt(x)))
  }
  const shares = new KeyShares(points, threshold, integrity).toBackupFormat()
  return { threshold, totalShares: shares.length, shares, integrity }
}

/** Suggested destinations for a 2-of-3 layout (transport only — not part of BRC-140). */
export const BRC140_DESTINATION_HINTS = [
  'Email to yourself (your mail client)',
  'Password manager / notes',
  'USB, paper, or another device',
] as const

export function shareDownloadFilename(index: number, total: number, integrity: string): string {
  return `handcash-brc140-share-${index + 1}-of-${total}-${integrity.slice(0, 4)}.txt`
}
