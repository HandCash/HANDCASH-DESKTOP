/**
 * Requests signed by the wallet's authority key, for recovery holders that
 * identify an account by that key. The header names, preimage labels and the
 * key's derivation protocol are wire format: holders verify them and existing
 * holder records are keyed by this public key, so none of them may change.
 */
import { Hash, KeyDeriver, PrivateKey, Signature, Utils } from '@bsv/sdk'
import { accountRootKeyHex } from './vaultMaster'
import type { ActiveWallet } from './session'

export const WALLET_AUTHORITY_PROTOCOL: [2, string] = [2, 'brc250 device']

function compactHex(sig: Signature): string {
  return Utils.toHex([
    ...sig.r.toArray('be', 32),
    ...sig.s.toArray('be', 32),
  ])
}

export function walletAuthorityKey(active: ActiveWallet): PrivateKey {
  const account0 = PrivateKey.fromHex(accountRootKeyHex(active.vaultMaster, 0))
  return new KeyDeriver(account0).derivePrivateKey(
    WALLET_AUTHORITY_PROTOCOL,
    '1',
    'self',
  )
}

export function signedRequestPreimage(
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

export function signedRequestHeaders(
  key: PrivateKey,
  method: string,
  path: string,
  bodyText: string,
): Record<string, string> {
  const at = Date.now()
  const nonce = Utils.toHex(
    Array.from(crypto.getRandomValues(new Uint8Array(16))),
  )
  const preimage = signedRequestPreimage(method, path, at, nonce, bodyText)
  return {
    'X-BRC250-Key': key.toPublicKey().toString().toLowerCase(),
    'X-BRC250-Timestamp': String(at),
    'X-BRC250-Nonce': nonce,
    'X-BRC250-Signature': compactHex(
      key.sign(Utils.toArray(preimage, 'utf8')),
    ),
  }
}

export async function signedFetch<T>(args: {
  host: string
  path: string
  key: PrivateKey
  method?: 'GET' | 'POST'
  body?: unknown
}): Promise<T> {
  const method = args.method ?? 'POST'
  const bodyText = method === 'GET' ? '' : JSON.stringify(args.body ?? {})
  const res = await fetch(`${args.host}${args.path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...signedRequestHeaders(args.key, method, args.path, bodyText),
    },
    ...(method === 'POST' ? { body: bodyText } : {}),
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(body.error || `Recovery holder refused (${res.status})`)
  return body
}
