import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import {
  brc29PrivateKey,
  brc29PublicKey,
  freshRemittanceString,
  readRemittance,
  remittanceFromTags,
  selfBrc29Output,
  type Remittance,
} from './brc29Keys'
import { scriptPaysAddress } from './ordinalOwnership'
import { TOKEN_BASKETS } from './assetBaskets'

/**
 * Which key signs a token or item tip: a BRC-29 child rebuilt from the
 * remittance in the tip's `customInstructions` or `brc29:` tag, or the
 * identity address that earlier releases paid.
 */
const P2PKH_RE = /76a914([0-9a-f]{40})88ac/g

type Cache = { identity: string; keys: Map<string, PrivateKey> }
let cache: Cache | null = null

function cacheFor(active: Pick<ActiveWallet, 'identityKey'>): Map<string, PrivateKey> {
  const identity = (active.identityKey ?? '').toLowerCase()
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
export function rememberTipKey(active: Pick<ActiveWallet, 'identityKey'>, key: PrivateKey): void {
  cacheFor(active).set(pkhOf(key), key)
}

/** Remember every key the remittance recorded on one tip may name. */
export function tipKeyFromInstructions(active: ActiveWallet, customInstructions: unknown): void {
  let parsed: unknown = customInstructions
  if (typeof customInstructions === 'string') {
    try {
      parsed = JSON.parse(customInstructions)
    } catch {
      return
    }
  }
  const remittance = readRemittance(parsed)
  if (!remittance) return
  try {
    rememberTipKey(active, brc29PrivateKey(PrivateKey.fromHex(active.rootKeyHex), remittance))
  } catch {
    /* a remittance this wallet cannot derive names no key of ours */
  }
}

/** Baskets whose token rows carry a remittance: the filings, and lots held by a direct offer. */
const TIP_KEY_BASKETS = TOKEN_BASKETS

/** Load every derived tip key from the baskets holding token rows into the cache. */
export async function primeTipKeys(active: ActiveWallet): Promise<void> {
  const startedAt = Date.now()
  for (const basket of TIP_KEY_BASKETS) {
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

/** Remember the key an item row's `brc29:` tag names. */
export function tipKeyFromTags(active: Pick<ActiveWallet, 'identityKey' | 'rootKeyHex'>, tags: readonly string[] | undefined): void {
  const remittance = remittanceFromTags(tags)
  if (!remittance) return
  try {
    rememberTipKey(active, brc29PrivateKey(PrivateKey.fromHex(active.rootKeyHex), remittance))
  } catch {
    /* a remittance this wallet cannot derive names no key of ours */
  }
}

const ITEM_PAGE = 500

/**
 * Load the derived key of every item tip in basket `1sat` from its tag. Tags
 * only: an item's `customInstructions` carry its provenance BEEF, and reading
 * them for a whole basket crashed phones.
 */
export async function primeItemTipKeys(active: ActiveWallet): Promise<void> {
  const startedAt = Date.now()
  try {
    for (let offset = 0; ; offset += ITEM_PAGE) {
      const page = await active.wallet.listOutputs({
        basket: '1sat',
        includeTags: true,
        includeCustomInstructions: false,
        limit: ITEM_PAGE,
        offset,
        seekPermission: false,
      })
      const outputs = page.outputs ?? []
      for (const o of outputs) tipKeyFromTags(active, o.tags)
      if (outputs.length < ITEM_PAGE) break
    }
  } catch (err) {
    console.warn('[tipKeys] 1sat unread', err instanceof Error ? err.message : String(err))
  }
  const ms = Date.now() - startedAt
  if (ms >= 250) console.info(`[tipKeys] item prime done ${ms}ms`)
}

/**
 * Who a lock pays, as far as this wallet can tell: its identity address
 * (earlier releases), a BRC-29 child it remembers, someone else, or nothing
 * to read. Only `address` locks ever show up in an address scan.
 */
export type LockHolder = 'address' | 'derived' | 'other' | 'unknown'

export function lockHolder(active: ActiveWallet, lockingScriptHex: string | null | undefined): LockHolder {
  if (!lockingScriptHex) return 'unknown'
  if (active.address && scriptPaysAddress(lockingScriptHex, active.address)) return 'address'
  const hashes = lockHashes(lockingScriptHex)
  if (active.identityKey && hashes.includes(identityPkh(active))) return 'address'
  const keys = cacheFor(active)
  return hashes.some((h) => keys.has(h)) ? 'derived' : 'other'
}

/** True when the lock pays a derived key this wallet holds, or its identity address (earlier releases). */
export function ownsTokenLock(active: ActiveWallet, lockingScriptHex: string | undefined): boolean {
  const holder = lockHolder(active, lockingScriptHex)
  return holder === 'address' || holder === 'derived'
}

/** One derived value output: the address it pays and the remittance that finds its key again. */
export type TokenOutputKey = { address: string; remittance: Remittance }

const PEER_KEY_RE = /^0[23][0-9a-f]{64}$/

/** A fresh BRC-29 child of this wallet, with its private key. */
export function selfTokenOutput(
  active: Pick<ActiveWallet, 'rootKeyHex' | 'identityKey'>,
  derivationPrefix: string = freshRemittanceString(),
): TokenOutputKey & { key: PrivateKey } {
  return selfBrc29Output(active, derivationPrefix)
}

/** A fresh BRC-29 child of `peerKey`, which only that identity can spend. */
export function peerTokenOutput(
  active: Pick<ActiveWallet, 'rootKeyHex' | 'identityKey'>,
  peerKey: string,
  derivationPrefix: string = freshRemittanceString(),
): TokenOutputKey {
  const remittance: Remittance = {
    derivationPrefix,
    derivationSuffix: freshRemittanceString(),
    senderIdentityKey: active.identityKey.toLowerCase(),
  }
  const pub = brc29PublicKey(
    PrivateKey.fromHex(active.rootKeyHex),
    remittance.derivationPrefix,
    remittance.derivationSuffix,
    peerKey,
  )
  return { address: pub.toAddress(), remittance }
}

/**
 * The keys of a token transfer: one fresh prefix for the
 * transfer, one suffix per output. The payee gets a child of its identity key
 * only when the transfer will be delivered to it, since the delivery carries
 * the remittance it needs; a bare address stays as given. Change and a
 * self-payee get this wallet's own children. `held` lists the private keys of
 * outputs this wallet keeps.
 */
export function planTokenOutputs(args: {
  wallet: Pick<ActiveWallet, 'rootKeyHex' | 'identityKey'>
  payeeIsSelf: boolean
  peerKey: string | null
  hasChange: boolean
}): { payee: TokenOutputKey | null; change: TokenOutputKey | null; held: PrivateKey[] } {
  const prefix = freshRemittanceString()
  const held: PrivateKey[] = []
  let payee: TokenOutputKey | null = null
  if (args.payeeIsSelf) {
    const self = selfTokenOutput(args.wallet, prefix)
    held.push(self.key)
    payee = { address: self.address, remittance: self.remittance }
  } else if (args.peerKey && PEER_KEY_RE.test(args.peerKey)) {
    payee = peerTokenOutput(args.wallet, args.peerKey, prefix)
  }
  let change: TokenOutputKey | null = null
  if (args.hasChange) {
    const self = selfTokenOutput(args.wallet, prefix)
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
  if (!key && hashes.length > 0) {
    await primeItemTipKeys(active)
    key = pick()
  }
  return key ?? root
}
