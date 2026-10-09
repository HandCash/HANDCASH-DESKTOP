/**
 * The vault master: the one 32-byte secret every account derives from
 * (BRC-208), and the subject of the emergency key and BRC-140 slices.
 *
 * `brc-157`: the master is BRC-157 entropy. Its BIP-32 master node never
 * signs; account n is profile `m/0'/n'`, so account 0 is `m/0'/0'`. Hardened
 * derivation has no BRC-100 surface, so no linkage reveal reaches the master
 * or a sibling account.
 *
 * `brc-42`: the master is a root key that is itself account 0 (BRC-75,
 * pre-BRC-75 HD, imported keys). Account n >= 1 is its BRC-42 `self` child
 * under the reserved protocol `[2, "account"]`, key ID `account-n`.
 */
import { BigNumber, HD, KeyDeriver, Mnemonic, PrivateKey } from '@bsv/sdk'

export const VAULT_ACCOUNT_PROTOCOL: [2, 'account'] = [2, 'account']

export type AccountDerivation = 'brc-42' | 'brc-157'

export type VaultMaster =
  | { derivation: 'brc-42'; keyHex: string }
  | {
      derivation: 'brc-157'
      /** The entropy key: entropy as a big-endian scalar, zero-padded to 32 bytes. */
      keyHex: string
      /** Bytes of entropy the phrase encodes: 32 for 24 words, 16 for 12. */
      entropyLength: number
    }

export type Brc157VaultMaster = Extract<VaultMaster, { derivation: 'brc-157' }>

const ENTROPY_LENGTHS = [16, 20, 24, 28, 32]
const CURVE_ORDER = new BigNumber(
  'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
  16,
)

function toHex32(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('').padStart(64, '0')
}

export function accountKeyId(index: number): string {
  return `account-${index}`
}

export function brc42VaultMaster(rootKeyHex: string): VaultMaster {
  return { derivation: 'brc-42', keyHex: PrivateKey.fromHex(rootKeyHex.trim()).toHex() }
}

/** BRC-157 entropy as the vault master. Zero and values >= n are refused. */
export function brc157VaultMaster(entropy: number[]): Brc157VaultMaster {
  if (!ENTROPY_LENGTHS.includes(entropy.length)) {
    throw new Error(`BRC-157 entropy must be 16 to 32 bytes in steps of 4, got ${entropy.length}`)
  }
  const scalar = new BigNumber(entropy)
  if (scalar.isZero() || scalar.cmp(CURVE_ORDER) >= 0) {
    throw new Error('BRC-157 entropy is outside the secp256k1 range')
  }
  return { derivation: 'brc-157', keyHex: toHex32(entropy), entropyLength: entropy.length }
}

/**
 * The BRC-157 reading of a reconstructed entropy key whose length was not
 * recorded: BRC-157's fallback heuristic over its leading zero bytes.
 */
export function brc157VaultMasterFromKey(keyHex: string): Brc157VaultMaster {
  const full = PrivateKey.fromHex(keyHex.trim()).toArray('be', 32)
  let leadingZeros = 0
  while (leadingZeros < full.length && full[leadingZeros] === 0) leadingZeros++
  const length = Math.max(16, Math.ceil((32 - leadingZeros) / 4) * 4)
  return brc157VaultMaster(full.slice(32 - length))
}

/** The phrase that encodes a BRC-157 master (identical words to the ones written down). */
export function brc157Mnemonic(master: Brc157VaultMaster): Mnemonic {
  const full = PrivateKey.fromHex(master.keyHex).toArray('be', 32)
  return Mnemonic.fromEntropy(full.slice(32 - master.entropyLength))
}

let profileBase: { key: string; node: HD } | null = null

/** `m/0'` for a BRC-157 master. One master is open at a time, so one entry. */
function brc157ProfileBase(master: Brc157VaultMaster): HD {
  const key = `${master.entropyLength}:${master.keyHex}`
  if (profileBase?.key !== key) {
    profileBase = { key, node: HD.fromSeed(brc157Mnemonic(master).toSeed()).derive("m/0'") }
  }
  return profileBase.node
}

/** Forget the cached BRC-157 node (lock / switch vault). */
export function forgetVaultMasterCache(): void {
  profileBase = null
}

/** Account `index`'s root private key (hex). */
export function accountRootKeyHex(master: VaultMaster, index: number): string {
  if (index < 0 || !Number.isInteger(index)) {
    throw new Error(`invalid account index: ${index}`)
  }
  if (master.derivation === 'brc-157') {
    return brc157ProfileBase(master).deriveChild(0x80000000 + index).privKey.toHex()
  }
  if (index === 0) return master.keyHex
  return new KeyDeriver(PrivateKey.fromHex(master.keyHex))
    .derivePrivateKey(VAULT_ACCOUNT_PROTOCOL, accountKeyId(index), 'self')
    .toHex()
}

export function accountIdentityKey(master: VaultMaster, index: number): string {
  return PrivateKey.fromHex(accountRootKeyHex(master, index)).toPublicKey().toString()
}

/** The vault's own identity: account 0's identity key. Keys the account store. */
export function vaultIdentityKey(master: VaultMaster): string {
  return accountIdentityKey(master, 0)
}

export function sameVaultMaster(a: VaultMaster, b: VaultMaster): boolean {
  if (a.derivation !== b.derivation || a.keyHex !== b.keyHex) return false
  return a.derivation !== 'brc-157' || a.entropyLength === (b as typeof a).entropyLength
}

/** Read a master out of stored JSON fields; absent derivation is a BRC-42 root (older records). */
export function parseVaultMaster(fields: {
  keyHex: string
  derivation?: unknown
  entropyLength?: unknown
}): VaultMaster {
  if (fields.derivation === undefined || fields.derivation === 'brc-42') {
    return brc42VaultMaster(fields.keyHex)
  }
  if (fields.derivation === 'brc-157' && typeof fields.entropyLength === 'number') {
    const full = PrivateKey.fromHex(fields.keyHex.trim()).toArray('be', 32)
    const cut = 32 - fields.entropyLength
    if (cut < 0 || full.slice(0, cut).some((b) => b !== 0)) {
      throw new Error('Vault entropy does not fit its recorded length')
    }
    return brc157VaultMaster(full.slice(cut))
  }
  throw new Error('Unsupported vault key derivation')
}
