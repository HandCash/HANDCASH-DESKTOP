import {
  BigNumber,
  Hash,
  KeyDeriver,
  PrivateKey,
  PublicKey,
  Signature,
  Utils,
} from '@bsv/sdk'
import { accountRootKeyHex } from '../vaultMaster'
import type { ActiveWallet } from '../session'

export const BRC250_DEVICE_PROTOCOL: [2, string] = [2, 'brc250 device']

function compactHex(sig: Signature): string {
  return Utils.toHex([
    ...sig.r.toArray('be', 32),
    ...sig.s.toArray('be', 32),
  ])
}

export function authorityPrivateKey(active: ActiveWallet): PrivateKey {
  const account0 = PrivateKey.fromHex(accountRootKeyHex(active.vaultMaster, 0))
  return new KeyDeriver(account0).derivePrivateKey(
    BRC250_DEVICE_PROTOCOL,
    '1',
    'self',
  )
}

export function requestPreimage(
  method: string,
  path: string,
  at: number,
  nonce: string,
  bodyText: string,
): string {
  const bodyHash = Utils.toHex(Hash.sha256(Utils.toArray(bodyText, 'utf8')))
  return [
    'brc250-request',
    'v1',
    method.toUpperCase(),
    path,
    String(at),
    nonce,
    bodyHash,
  ].join('\n')
}

export function signedHeaders(
  key: PrivateKey,
  method: string,
  path: string,
  bodyText: string,
): Record<string, string> {
  const at = Date.now()
  const nonce = Utils.toHex(
    Array.from(crypto.getRandomValues(new Uint8Array(16))),
  )
  const preimage = requestPreimage(method, path, at, nonce, bodyText)
  return {
    'X-BRC250-Key': key.toPublicKey().toString().toLowerCase(),
    'X-BRC250-Timestamp': String(at),
    'X-BRC250-Nonce': nonce,
    'X-BRC250-Signature': compactHex(
      key.sign(Utils.toArray(preimage, 'utf8')),
    ),
  }
}

export function verifyIdentifier(
  identifier: {
    signature: string
    [key: string]: unknown
  },
  attesterKey: string,
): boolean {
  try {
    const { signature: signatureHex, ...unsigned } = identifier
    const preimage = `brc250-identifier\nv1\n${JSON.stringify(unsigned)}`
    const raw = Utils.toArray(signatureHex, 'hex')
    const signature = new Signature(
      new BigNumber(raw.slice(0, 32)),
      new BigNumber(raw.slice(32)),
    )
    return PublicKey.fromString(attesterKey).verify(
      Utils.toArray(preimage, 'utf8'),
      signature,
    )
  } catch {
    return false
  }
}

export function freshLoginKey(): PrivateKey {
  return PrivateKey.fromRandom()
}

export function randomHex(bytes: number): string {
  return Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(bytes))))
}

export function commitmentFor(loginKey: PublicKey, rA: string): string {
  return Utils.toHex(
    Hash.sha256(
      Utils.toArray(
        `brc250-commit\n${loginKey.toString().toLowerCase()}\n${rA}`,
        'utf8',
      ),
    ),
  )
}

export function comparisonCode(binding: string, rA: string, rB: string): string {
  const digest = Hash.sha256(
    Utils.toArray(`brc250-code\n${binding}\n${rA}\n${rB}`, 'utf8'),
  )
  let n = 0n
  for (const byte of digest.slice(0, 8)) n = (n << 8n) | BigInt(byte)
  return (n % 100_000_000n).toString().padStart(8, '0')
}
