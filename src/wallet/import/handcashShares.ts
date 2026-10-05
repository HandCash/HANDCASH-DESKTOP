import { Curve, HD, PrivateKey } from '@bsv/sdk'

/**
 * HandCash two-party key export.
 *
 * The HandCash app exports a wallet as two extended private keys, one per
 * share of a two-party ECDSA key. The shares are multiplicative, so both
 * together compose the real spending key at any path:
 *
 *   d = (d₁ · d₂) mod n
 *
 * Both shares are derived at the same path first, then combined. Addresses
 * are `m/<root>/<index>` relative to the exported keys, with no BIP-44 levels.
 *
 * Ported from HandCash/recovery-tool `lib/handcash/keyring.ts`; the fixtures in
 * `handcashShares.test.ts` come from that repo's independent Python reference.
 */

const XPRV_PREFIX = 'xprv'

/** Every extended key in pasted text — an export copied as one block still splits. */
export function extractExtendedKeys(text: string): string[] {
  return text.match(/\b[xt](?:prv|pub)[1-9A-HJ-NP-Za-km-z]{100,}/g) ?? []
}

/** One exported share, or null when it is not a usable mainnet xprv. */
export function parseExtendedPrivateKey(input: string): HD | null {
  const key = input.trim()
  if (!key.startsWith(XPRV_PREFIX)) return null
  try {
    const hd = HD.fromString(key)
    return hd.privKey ? hd : null
  } catch {
    return null
  }
}

/** Why one key was rejected, or null when it is fine. */
export function describeKeyProblem(input: string): string | null {
  const key = input.trim()
  if (key.length === 0) return 'Paste the key here.'
  if (parseExtendedPrivateKey(key)) return null
  if (key.startsWith('xpub')) {
    return 'This is a public key (xpub). Recovery needs the private key, which starts with xprv.'
  }
  if (key.startsWith('tprv') || key.startsWith('tpub')) {
    return 'This is a testnet key. HandCash wallets use mainnet keys, which start with xprv.'
  }
  if (!key.startsWith(XPRV_PREFIX)) return 'An extended private key starts with xprv.'
  return 'This key is not valid. Make sure it was copied in full, with no characters missing or changed.'
}

/** Why the pair was rejected, naming the field at fault, or null. */
export function describeKeyPairProblem(first: string, second: string): string | null {
  const firstProblem = describeKeyProblem(first)
  if (firstProblem) return `First key: ${firstProblem}`
  const secondProblem = describeKeyProblem(second)
  if (secondProblem) return `Second key: ${secondProblem}`
  // The same share twice composes d², a valid key for a wallet nobody owns.
  if (first.trim() === second.trim()) {
    return 'Both fields hold the same key. Enter the two different keys from your export.'
  }
  return null
}

export class HandCashKeyring {
  private readonly shares: HD[]
  /** A scan derives thousands of addresses; derive each `m/<root>` node once. */
  private readonly rootNodes = new Map<string, HD[]>()

  private constructor(shares: HD[]) {
    this.shares = shares
  }

  /** Order does not matter: multiplication mod n is commutative. */
  static fromExtendedKeys(first: string, second: string): HandCashKeyring {
    const problem = describeKeyPairProblem(first, second)
    if (problem) throw new Error(problem)
    return new HandCashKeyring([
      parseExtendedPrivateKey(first) as HD,
      parseExtendedPrivateKey(second) as HD,
    ])
  }

  private nodesForRoot(rootPath: string): HD[] {
    const cached = this.rootNodes.get(rootPath)
    if (cached) return cached
    const nodes = this.shares.map((share) =>
      rootPath === 'm' || rootPath === '' ? share : share.derive(rootPath),
    )
    this.rootNodes.set(rootPath, nodes)
    return nodes
  }

  /** Composed spendable key at `path`, e.g. `m/4/12`. `m` composes the export roots. */
  privateKeyAt(path: string): PrivateKey {
    let first: PrivateKey
    let second: PrivateKey
    if (path === 'm') {
      ;[first, second] = this.shares.map((share) => share.privKey) as [PrivateKey, PrivateKey]
    } else {
      const separator = path.lastIndexOf('/')
      const rootPath = path.slice(0, separator)
      const childIndex = Number(path.slice(separator + 1))
      if (!Number.isInteger(childIndex) || childIndex < 0) {
        throw new Error(`Not a HandCash path: ${path}`)
      }
      ;[first, second] = this.nodesForRoot(rootPath).map(
        (node) => node.deriveChild(childIndex).privKey,
      ) as [PrivateKey, PrivateKey]
    }
    const composed = first.mul(second).umod(new Curve().n)
    if (composed.isZero()) throw new Error(`Recovered an invalid key at ${path}.`)
    return PrivateKey.fromHex(composed.toHex(32))
  }
}
