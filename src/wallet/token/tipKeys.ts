import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import type { ActiveWallet } from '../session'
import {
  colorPrivateKey,
  colorPublicKey,
  freshRemittanceString,
  readColorRemittance,
  type ColorRemittance,
} from '../colorKeys'
import { normalizeTokenId } from './types'
import { TOKEN_FILING_BASKETS } from './filing'
import { scriptPaysAddress } from '../ordinalOwnership'

/**
 * Which key signs a token tip. Tips paid to the identity address sign with the
 * root key; tips under a `p color` child sign with the child rebuilt from the
 * remittance recorded in the tip's `customInstructions`. Anything this wallet
 * cannot place keeps the root key, which is what every tip used before
 * derived outputs existed.
 */
const P2PKH_RE = /76a914([0-9a-f]{40})88ac/g

type Cache = { identity: string; keys: Map<string, PrivateKey> }
let cache: Cache | null = null

function cacheFor(active: ActiveWallet): Map<string, PrivateKey> {
  const identity = active.identityKey.toLowerCase()
  if (cache?.identity !== identity) cache = { identity, keys: new Map() }
  return cache.keys
}

function lockHashes(lockingScriptHex: string): string[] {
  return [...lockingScriptHex.toLowerCase().matchAll(P2PKH_RE)].map((m) => m[1]!)
}

function pkhOf(key: PrivateKey): string {
  return Utils.toHex(Hash.hash160(key.toPublicKey().encode(true) as number[]))
}

function identityPkh(active: ActiveWallet): string {
  return Utils.toHex(Hash.hash160(Utils.toArray(active.identityKey, 'hex')))
}

/** Remember a derived key this wallet just wrote or received a tip under. */
export function rememberTipKey(active: ActiveWallet, key: PrivateKey): void {
  cacheFor(active).set(pkhOf(key), key)
}

/** The derived key recorded in one tip's `customInstructions`, when it has one. */
export function tipKeyFromInstructions(active: ActiveWallet, customInstructions: unknown): PrivateKey | null {
  let parsed: unknown = customInstructions
  if (typeof customInstructions === 'string') {
    try {
      parsed = JSON.parse(customInstructions)
    } catch {
      return null
    }
  }
  const remittance = readColorRemittance(parsed)
  const id = normalizeTokenId(String((parsed as { id?: unknown } | null)?.id ?? ''))
  if (!remittance || !id) return null
  try {
    const key = colorPrivateKey(PrivateKey.fromHex(active.rootKeyHex), id, remittance)
    rememberTipKey(active, key)
    return key
  } catch {
    return null
  }
}

/** Load every derived tip key from the token filings into the cache. */
export async function primeTipKeys(active: ActiveWallet): Promise<void> {
  const startedAt = Date.now()
  for (const basket of TOKEN_FILING_BASKETS) {
    try {
      const page = await active.wallet.listOutputs({ basket, include: 'locking scripts', includeCustomInstructions: true, limit: 1000 })
      for (const o of page.outputs ?? []) tipKeyFromInstructions(active, o.customInstructions)
    } catch (err) {
      console.warn(`[tipKeys] ${basket} unread`, err instanceof Error ? err.message : String(err))
    }
  }
  const ms = Date.now() - startedAt
  if (ms >= 250) console.info(`[tipKeys] prime done ${ms}ms`)
}

/** True when the lock pays this wallet's identity address or a derived key it holds. */
export function ownsTokenLock(active: ActiveWallet, lockingScriptHex: string | undefined): boolean {
  if (!lockingScriptHex) return false
  if (active.address && scriptPaysAddress(lockingScriptHex, active.address)) return true
  if (!active.identityKey) return false
  const keys = cacheFor(active)
  const self = identityPkh(active)
  return lockHashes(lockingScriptHex).some((h) => h === self || keys.has(h))
}

/** One derived value output: the address it pays and the remittance that finds its key again. */
export type ColorOutput = { address: string; remittance: ColorRemittance }

const PEER_KEY_RE = /^0[23][0-9a-f]{64}$/

/** A fresh `p color` child of this wallet (counterparty `self`), with its private key. */
export function selfColorOutput(
  active: Pick<ActiveWallet, 'rootKeyHex' | 'identityKey'>,
  tokenId: string,
  derivationPrefix: string = freshRemittanceString(),
): ColorOutput & { key: PrivateKey } {
  const root = PrivateKey.fromHex(active.rootKeyHex)
  const remittance: ColorRemittance = {
    derivationPrefix,
    derivationSuffix: freshRemittanceString(),
    senderIdentityKey: active.identityKey.toLowerCase(),
  }
  const key = colorPrivateKey(root, tokenId, remittance)
  return { address: key.toAddress(), remittance, key }
}

/** A fresh `p color` child of `peerKey`, which only that identity can spend. */
export function peerColorOutput(
  active: Pick<ActiveWallet, 'rootKeyHex' | 'identityKey'>,
  tokenId: string,
  peerKey: string,
  derivationPrefix: string = freshRemittanceString(),
): ColorOutput {
  const remittance: ColorRemittance = {
    derivationPrefix,
    derivationSuffix: freshRemittanceString(),
    senderIdentityKey: active.identityKey.toLowerCase(),
  }
  const pub = colorPublicKey(
    PrivateKey.fromHex(active.rootKeyHex),
    tokenId,
    remittance.derivationPrefix,
    remittance.derivationSuffix,
    peerKey,
  )
  return { address: pub.toAddress(), remittance }
}

/**
 * The keys of a P2P-FT transfer (BRC-251 Custody): one fresh prefix for the
 * transfer, one suffix per output. The payee gets a child of its identity key
 * only when the transfer will be delivered to it, since the delivery carries
 * the remittance it needs; a bare address stays as given. Change and a
 * self-payee get this wallet's own children. `held` lists the private keys of
 * outputs this wallet keeps.
 */
export function planColorOutputs(args: {
  wallet: Pick<ActiveWallet, 'rootKeyHex' | 'identityKey'>
  tokenId: string
  payeeIsSelf: boolean
  peerKey: string | null
  hasChange: boolean
}): { payee: ColorOutput | null; change: ColorOutput | null; held: PrivateKey[] } {
  const prefix = freshRemittanceString()
  const held: PrivateKey[] = []
  let payee: ColorOutput | null = null
  if (args.payeeIsSelf) {
    const self = selfColorOutput(args.wallet, args.tokenId, prefix)
    held.push(self.key)
    payee = { address: self.address, remittance: self.remittance }
  } else if (args.peerKey && PEER_KEY_RE.test(args.peerKey)) {
    payee = peerColorOutput(args.wallet, args.tokenId, args.peerKey, prefix)
  }
  let change: ColorOutput | null = null
  if (args.hasChange) {
    const self = selfColorOutput(args.wallet, args.tokenId, prefix)
    held.push(self.key)
    change = { address: self.address, remittance: self.remittance }
  }
  return { payee, change, held }
}

/** The key that signs a tip with this locking script. */
export async function tipSigningKey(
  active: ActiveWallet,
  lockingScriptHex: string,
  customInstructions?: unknown,
): Promise<PrivateKey> {
  const root = PrivateKey.fromHex(active.rootKeyHex)
  const hashes = lockHashes(lockingScriptHex)
  if (hashes.includes(identityPkh(active))) return root
  const keys = cacheFor(active)
  const pick = () => hashes.map((h) => keys.get(h)).find((k): k is PrivateKey => k != null)
  if (customInstructions != null) tipKeyFromInstructions(active, customInstructions)
  let key = pick()
  if (!key && hashes.length > 0) {
    await primeTipKeys(active)
    key = pick()
  }
  return key ?? root
}
