/**
 * Fungible send entrypoint.
 *
 * 1Sat FT (Collect rows with `colourSupply`) spend tip UTXOs and create payee
 * (+ change) tips with conserved face-value `amt`. Legacy BSV-21 wallet sends
 * are retired; helpers below remain for tests / recovery tooling.
 */
import { Beef } from '@bsv/sdk'
import {
  formatFungibleAmount,
  normalizeTokenId,
  type Bsv21Utxo,
  type FungibleToken,
} from './bsv21'
import { getBeefForTxidCached } from './beefCache'
import { getCachedFungibles, getFungible } from './fungibles'
import type { ActiveWallet } from './session'

/** A wallet action must never hold the spend coordinator indefinitely. */
export const FUNGIBLE_CREATE_ACTION_TIMEOUT_MS = 45_000

class FungibleCreateActionTimeoutError extends Error {
  constructor() {
    super('Token transfer preparation timed out')
    this.name = 'FungibleCreateActionTimeoutError'
  }
}

export async function withFungibleCreateActionTimeout<T>(
  work: Promise<T>,
  timeoutMs = FUNGIBLE_CREATE_ACTION_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new FungibleCreateActionTimeoutError()),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function wireOutpoint(op: string): string {
  const t = op.trim().toLowerCase()
  return t.includes('.') ? t : t.replace(/_(\d+)$/, '.$1')
}

/**
 * Supply source transactions explicitly for custom token inputs.
 * Kept for recovery / legacy tooling that still builds BSV-21 actions.
 */
export async function buildFungibleInputBeef(
  wallet: ActiveWallet,
  outpoints: string[],
  loadBeef: typeof getBeefForTxidCached = (wallet, txid, opts) =>
    getBeefForTxidCached(wallet, txid, { ...opts, needProof: true }),
): Promise<{ inputBEEF: number[]; knownTxids: string[] }> {
  const knownTxids = [
    ...new Set(
      outpoints
        .map((op) => wireOutpoint(op).split('.')[0])
        .filter((txid): txid is string => Boolean(txid)),
    ),
  ]
  const merged = new Beef()
  for (const txid of knownTxids) {
    const beef = await loadBeef(wallet, txid)
    merged.mergeBeef(beef.toBinary())
  }
  return { inputBEEF: Array.from(merged.toBinary()), knownTxids }
}

function parseDisplayAmount(raw: string, dec: number): bigint {
  const trimmed = raw.trim().replace(/,/g, '')
  if (!trimmed) throw new Error('Enter an amount')
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error('Invalid amount')
  const [wholeRaw, fracRaw = ''] = trimmed.split('.')
  if (fracRaw.length > dec) {
    throw new Error(
      dec === 0
        ? 'This token has no decimal places'
        : `At most ${dec} decimal place${dec === 1 ? '' : 's'}`,
    )
  }
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || '0'
  const frac = fracRaw.padEnd(dec, '0')
  const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, '') || '0'
  const n = BigInt(digits)
  if (n <= 0n) throw new Error('Amount must be greater than zero')
  return n
}

export function parseFungibleSendAmount(
  raw: string,
  token: Pick<FungibleToken, 'dec' | 'amt'>,
): { units: bigint; unitsStr: string } {
  const units = parseDisplayAmount(raw, token.dec)
  const held = BigInt(token.amt.replace(/\D/g, '') || '0')
  if (units > held) {
    throw new Error(
      `Insufficient balance (have ${formatFungibleAmount(token.amt, token.dec)})`,
    )
  }
  return { units, unitsStr: units.toString() }
}

/** Greedy largest-first selection until `need` units are covered. */
export function selectFungibleTips(
  tips: Bsv21Utxo[],
  need: bigint,
): { selected: Bsv21Utxo[]; selectedSum: bigint } {
  const sorted = [...tips].sort((a, b) => {
    const da = BigInt(a.amt.replace(/\D/g, '') || '0')
    const db = BigInt(b.amt.replace(/\D/g, '') || '0')
    return db > da ? 1 : db < da ? -1 : 0
  })
  const selected: Bsv21Utxo[] = []
  let selectedSum = 0n
  for (const tip of sorted) {
    if (selectedSum >= need) break
    const amt = BigInt(tip.amt.replace(/\D/g, '') || '0')
    if (amt <= 0n) continue
    selected.push(tip)
    selectedSum += amt
  }
  if (selectedSum < need) {
    throw new Error('Not enough token outputs to cover this send')
  }
  return { selected, selectedSum }
}

export async function sendFungible(args: {
  tokenId: string
  /** Display amount (with decimals) or integer token units. */
  amount: string
  toAddress: string
  recipientIdentityKey?: string | null
  friendLabel?: string | null
}): Promise<{ txid: string }> {
  const tokenId = normalizeTokenId(args.tokenId) ?? args.tokenId.trim().toLowerCase()
  const token =
    getFungible(tokenId) ??
    getCachedFungibles().find(
      (t) => t.tokenId === tokenId || t.tokenIds?.includes(tokenId),
    )
  if (!token) throw new Error('Token not found in this wallet')

  // 1Sat FT (Collect rows with colourSupply): face-value tip spend + change.
  if (token.colourSupply != null) {
    const units = /^\d+$/.test(args.amount.trim())
      ? BigInt(args.amount.trim())
      : BigInt(parseFungibleSendAmount(args.amount, token).unitsStr)
    if (units <= 0n) throw new Error('Amount must be greater than zero')
    if (!Number.isSafeInteger(Number(units))) {
      throw new Error('Amount too large')
    }
    const held = BigInt(token.amt.replace(/\D/g, '') || '0')
    if (units > held) {
      throw new Error(
        `Insufficient balance (have ${formatFungibleAmount(token.amt, token.dec)})`,
      )
    }
    const { sendColourCoins } = await import('./sendColourCoins')
    const result = await sendColourCoins({
      origin: token.tokenId,
      amount: Number(units),
      toAddress: args.toAddress,
      friendLabel: args.friendLabel,
      recipientIdentityKey: args.recipientIdentityKey,
      sym: token.sym,
      supply: token.colourSupply,
      maxSupply: token.colourMaxSupply ?? null,
      ...(token.icon ? { icon: token.icon } : {}),
    })
    return { txid: result.txid }
  }

  throw new Error(
    'BSV-21 wallet sends are retired. 1Sat tokens use face-value tip spends under a shared origin.',
  )
}
