/**
 * Developer key: the current BAP signing key of the identity this account
 * shares, for a server that signs (AIP / Sigma) as that identity.
 *
 * Its capacity is limited by derivation, not by a policy the server could
 * ignore:
 * - It is `identity-<seq>` under `[1,'sigma']`, a BRC-42 `self` child of the
 *   identity master. The child reveals neither the master, nor a sibling, nor
 *   any funds key, and it holds no coins.
 * - The root (`identity-0`) is never handed out, so the wallet can always
 *   revoke the identity outright.
 * - It signs anything the identity signs, including the next key rotation.
 *   Rotating in the wallet retires it: verifiers follow the chain to the new
 *   current key, and a server needs the new developer key.
 */
import { presentedIdentityMaterial } from './publicIdentities'
import type { WalletRuntime } from './walletRuntime'

export type DevSigningKeyRefusal = 'not-published' | 'revoked' | 'root-key'

export class DevSigningKeyRefused extends Error {
  constructor(
    readonly reason: DevSigningKeyRefusal,
    message: string,
  ) {
    super(message)
    this.name = 'DevSigningKeyRefused'
  }
}

export type DevSigningKeyInfo = {
  bapId: string
  name: string
  /** `identity-<seq>`; always ≥ 1. */
  seq: number
  /** Address verifiers expect in the AIP signer field. */
  address: string
  publicKey: string
}

export type DevSigningKey = DevSigningKeyInfo & { wif: string }

function refuse(reason: DevSigningKeyRefusal, message: string): never {
  throw new DevSigningKeyRefused(reason, message)
}

function resolve(runtime: WalletRuntime): DevSigningKey {
  const material = presentedIdentityMaterial(runtime)
  if (!material) refuse('not-published', 'Publish an identity first.')
  if (material.kind === 'withdrawn') refuse('revoked', 'This account no longer shares an identity.')
  const current = material.identity.keys.at(-1)
  if (!current || current.seq < 1) refuse('root-key', 'The identity root key never leaves the wallet.')
  const key = material.signingKey
  return {
    bapId: material.identity.bapId,
    name: material.identity.name,
    seq: current.seq,
    address: key.toAddress(),
    publicKey: key.toPublicKey().toString(),
    wif: key.toWif(runtime.instance.chain === 'test' ? [0xef] : undefined),
  }
}

/** Public facts about the developer key, or the reason there is none. */
export function describeDevSigningKey(
  runtime: WalletRuntime,
): { kind: 'ready'; key: DevSigningKeyInfo } | { kind: 'refused'; reason: DevSigningKeyRefusal; message: string } {
  try {
    const { wif: _wif, ...key } = resolve(runtime)
    return { kind: 'ready', key }
  } catch (error) {
    if (error instanceof DevSigningKeyRefused) {
      return { kind: 'refused', reason: error.reason, message: error.message }
    }
    throw error
  }
}

/** The developer key itself. Only an explicit user export should call this. */
export function exportDevSigningKey(runtime: WalletRuntime): DevSigningKey {
  try {
    const key = resolve(runtime)
    console.info(`[dev-key] exported identity-${key.seq} for ${key.bapId}`)
    return key
  } catch (error) {
    if (error instanceof DevSigningKeyRefused) console.warn(`[dev-key] refused ${error.reason}`)
    throw error
  }
}
