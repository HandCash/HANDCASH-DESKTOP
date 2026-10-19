import type { PrivateKey } from '@bsv/sdk'
import { parseDogeTx } from '../doge/dogecoin'
import { fromHex, ltcTxid, parseLtcTx, toHex, type Bytes, type LtcTx } from '../ltc/litecoin'
import type { SwapAsset } from './assets'
import type { FeeChainReader, FeeLockOutput } from './feeClaim'
import { htlcOutput, readSecret, sha256, signHtlcSpend, type HtlcCoin } from './htlc'

/**
 * A claim watchtower for the maker of a swap (BRC-CLOUD `swapTower.js`,
 * vendored from here by `npm run sync:swap-fees`).
 *
 * The maker learns the secret only when the taker claims the maker's lock,
 * and must claim the taker's lock before the taker may take it back. A maker
 * offline across that window loses both sides. So once the taker's lock is
 * buried, the maker signs its claim in advance with a placeholder secret and
 * hands it out as a ticket. A claim's signature does not cover the secret
 * (it sits in the unlocking data), so whoever sees the taker's claim can read
 * the secret from it, put it in the ticket, and broadcast. The claim pays
 * only the maker: a tower holds no key and decides nothing. It can only be
 * late, and the maker's own wallet still claims whenever it runs.
 */

export const CLAIM_TOWER_PATH = '/v1/swap-tower'

/** A claim signed with its secret zeroed; `secretAt` is the secret's byte offset in `hex`. */
export type ClaimTemplate = { chain: SwapAsset; hex: string; secretAt: number }

export type ClaimTicket = {
  v: 1
  /** The maker's own lock: the taker's claim of it shows the secret. `script` is its HTLC script. */
  watch: { chain: SwapAsset; txid: string; vout: number; script: string }
  /** sha256 of the swap secret. */
  hash: string
  /** The maker's claim of the taker's lock; `script` is that lock's HTLC script. */
  claim: ClaimTemplate & { script: string }
  /** Unix seconds: the taker may take its lock back from here. */
  until: number
}

const CHAINS: readonly SwapAsset[] = ['bsv', 'ltc', 'bch', 'btc', 'doge']
const HEX = /^(?:[0-9a-f]{2})+$/
const HEX64 = /^[0-9a-f]{64}$/
const SECRET_BYTES = 32
/** A one-input, one-output claim is a few hundred bytes; anything far larger is not one. */
const MAX_CLAIM_BYTES = 2_000
/** A BSV HTLC builds its own preimage signature and runs to some 700 bytes. */
const MAX_SCRIPT_BYTES = 1_500
/** A swap's locks run 72 hours at most. */
const MAX_UNTIL_AHEAD_S = 7 * 24 * 3600
/** Signed in place of the secret, then zeroed. Fixed so a ticket is the same for the same claim. */
const PLACEHOLDER = sha256(new TextEncoder().encode('handcash swap claim tower placeholder secret'))

/** A transaction from its hex, refused unless it hashes to `txid` (when given). */
export function checkedTx(chain: SwapAsset, hex: string, txid?: string): LtcTx {
  const raw = fromHex(hex)
  const tx = chain === 'doge' ? parseDogeTx(raw) : parseLtcTx(raw)
  if (txid && ltcTxid(tx) !== txid) throw new Error('the transaction does not hash to its txid')
  return tx
}

const indexOf = (hay: Bytes, needle: Bytes, from = 0): number => {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Sign the claim of `coin` to `to` now, with the secret left out. Refused unless the placeholder sits once in the bytes. */
export function presignClaim(chain: SwapAsset, args: { coin: HtlcCoin; to: Bytes; key: PrivateKey; feeRate: number }): ClaimTemplate {
  const signed = signHtlcSpend(chain, { coins: [args.coin], to: args.to, key: args.key, path: { kind: 'claim', preimage: PLACEHOLDER }, feeRate: args.feeRate })
  const bytes = fromHex(signed.hex)
  const at = indexOf(bytes, PLACEHOLDER)
  if (at < 0 || indexOf(bytes, PLACEHOLDER, at + 1) >= 0) throw new Error('the claim does not carry its secret once')
  bytes.fill(0, at, at + SECRET_BYTES)
  return { chain, hex: toHex(bytes), secretAt: at }
}

/** The template with `secret` in place: the claim, ready to broadcast. */
export function fillClaim(template: ClaimTemplate, secret: Bytes, hash: string): { hex: string; txid: string; value: bigint } {
  if (secret.length !== SECRET_BYTES || toHex(sha256(secret)) !== hash) throw new Error('the secret does not open this swap')
  const bytes = fromHex(template.hex)
  const at = template.secretAt
  if (!Number.isSafeInteger(at) || at < 0 || at + SECRET_BYTES > bytes.length) throw new Error('the template has no room for the secret')
  if (bytes.subarray(at, at + SECRET_BYTES).some((b) => b !== 0)) throw new Error('the template does not leave the secret out')
  bytes.set(secret, at)
  const tx = checkedTx(template.chain, toHex(bytes))
  const out = tx.outputs[0]
  if (tx.inputs.length !== 1 || tx.outputs.length !== 1 || !out) throw new Error('a claim spends one lock to one output')
  return { hex: toHex(bytes), txid: ltcTxid(tx), value: out.value }
}

const lockOutput = (chain: SwapAsset, scriptHex: string): FeeLockOutput => {
  const script = fromHex(scriptHex)
  return { script, ...htlcOutput(chain, script) }
}

/** A ticket as a tower stores it, or null for anything a wallet would not send. */
export function parseClaimTicket(raw: unknown, nowS = Math.floor(Date.now() / 1000)): ClaimTicket | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const w = t.watch as Record<string, unknown> | undefined
  const c = t.claim as Record<string, unknown> | undefined
  if (t.v !== 1 || !w || !c || typeof w !== 'object' || typeof c !== 'object') return null
  const watchChain = w.chain as SwapAsset
  const claimChain = c.chain as SwapAsset
  if (!CHAINS.includes(watchChain) || !CHAINS.includes(claimChain) || watchChain === claimChain) return null
  if (typeof w.txid !== 'string' || !HEX64.test(w.txid) || !Number.isSafeInteger(w.vout) || (w.vout as number) < 0 || (w.vout as number) > 1000) return null
  if (typeof t.hash !== 'string' || !HEX64.test(t.hash)) return null
  for (const s of [w.script, c.script]) if (typeof s !== 'string' || !HEX.test(s) || s.length > MAX_SCRIPT_BYTES * 2) return null
  if (typeof c.hex !== 'string' || !HEX.test(c.hex) || c.hex.length > MAX_CLAIM_BYTES * 2) return null
  if (!Number.isSafeInteger(t.until) || (t.until as number) < 500_000_000 || (t.until as number) > nowS + MAX_UNTIL_AHEAD_S) return null
  const ticket: ClaimTicket = {
    v: 1,
    watch: { chain: watchChain, txid: w.txid, vout: w.vout as number, script: w.script as string },
    hash: t.hash,
    claim: { chain: claimChain, hex: c.hex, secretAt: c.secretAt as number, script: c.script as string },
    until: t.until as number,
  }
  try {
    const bytes = fromHex(ticket.claim.hex)
    const at = ticket.claim.secretAt
    if (!Number.isSafeInteger(at) || at < 0 || at + SECRET_BYTES > bytes.length || bytes.subarray(at, at + SECRET_BYTES).some((b) => b !== 0)) return null
    const tx = checkedTx(claimChain, ticket.claim.hex)
    if (tx.inputs.length !== 1 || tx.outputs.length !== 1) return null
    lockOutput(watchChain, ticket.watch.script)
    lockOutput(claimChain, ticket.claim.script)
    const hashPush = fromHex('20' + ticket.hash)
    if (indexOf(fromHex(ticket.watch.script), hashPush) < 0 || indexOf(fromHex(ticket.claim.script), hashPush) < 0) return null
  } catch {
    return null
  }
  return ticket
}

/**
 * The watched lock and the template's hash: anyone can name a public
 * outpoint, so a ticket sent first never shuts out the maker's own.
 */
export const claimTicketId = (t: Pick<ClaimTicket, 'watch' | 'claim'>): string =>
  `${t.watch.chain}:${t.watch.txid}:${t.watch.vout}:${toHex(sha256(fromHex(t.claim.hex))).slice(0, 16)}`

/** The outpoint the claim spends: the taker's lock. */
export function claimOutpoint(t: Pick<ClaimTicket, 'claim'>): { txid: string; vout: number } {
  const input = checkedTx(t.claim.chain, t.claim.hex).inputs[0]!
  return { txid: input.txid, vout: input.vout }
}

export type ClaimTicketVerdict =
  /** The maker's lock is unspent: nothing to do yet. */
  | { kind: 'waiting' }
  /** The taker claimed: here is the maker's claim, filled. */
  | { kind: 'claim'; hex: string; txid: string }
  /** The maker took its lock back: no swap, nothing to claim. */
  | { kind: 'void'; txid: string }

/** Read the maker's lock: once the taker's claim shows the secret, fill the maker's claim with it. */
export async function judgeClaimTicket(t: ClaimTicket, watchReader: FeeChainReader): Promise<ClaimTicketVerdict> {
  const outpoint = { txid: t.watch.txid, vout: t.watch.vout }
  const hex = await watchReader.spenderHex(outpoint, lockOutput(t.watch.chain, t.watch.script))
  if (!hex) return { kind: 'waiting' }
  const tx = checkedTx(t.watch.chain, hex)
  const vin = tx.inputs.findIndex((i) => i.txid === outpoint.txid && i.vout === outpoint.vout)
  if (vin < 0) throw new Error('the named spender does not spend the watched lock')
  const secret = readSecret(t.watch.chain, tx, vin, fromHex(t.hash))
  if (!secret) return { kind: 'void', txid: ltcTxid(tx) }
  const claim = fillClaim(t.claim, secret, t.hash)
  return { kind: 'claim', hex: claim.hex, txid: claim.txid }
}

export type ClaimLanding =
  /** The taker's lock is unspent: the claim has not landed (yet). */
  | { kind: 'unspent' }
  /** Spent with the secret: the maker's claim, the tower's or its own. */
  | { kind: 'claimed'; txid: string }
  /** Spent without it: the taker's refund won the race. */
  | { kind: 'lost'; txid: string }

/** Who holds the taker's lock now. */
export async function claimLanding(t: ClaimTicket, claimReader: FeeChainReader): Promise<ClaimLanding> {
  const outpoint = claimOutpoint(t)
  const hex = await claimReader.spenderHex(outpoint, lockOutput(t.claim.chain, t.claim.script))
  if (!hex) return { kind: 'unspent' }
  const tx = checkedTx(t.claim.chain, hex)
  const vin = tx.inputs.findIndex((i) => i.txid === outpoint.txid && i.vout === outpoint.vout)
  if (vin < 0) throw new Error('the named spender does not spend the taker lock')
  const txid = ltcTxid(tx)
  return readSecret(t.claim.chain, tx, vin, fromHex(t.hash)) ? { kind: 'claimed', txid } : { kind: 'lost', txid }
}
