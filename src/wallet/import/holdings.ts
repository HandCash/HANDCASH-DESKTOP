import type { Chain } from '../vault'
import { appendAppLog } from '../appLog'
import { chooseLegacySweepPath } from '../legacySweepPath'
import { countOrdinalsAtLeast, scanAddressAny } from '../phraseSweep'
import { yieldToUi } from '../yieldToUi'
import type { DiscoveredAddress } from './discovery'

/**
 * What a discovered address holds right now, and which of it is compatible.
 *
 * Compatible = this wallet can take custody without changing what the asset
 * is: plain cash, 1-sat collectables, and valid BSV-21 tokens. Everything else
 * stays at the source with a named reason. Nothing here spends.
 */

export type TokenStandard = 'bsv21' | 'bsv20'

export type TokenHolding = {
  /** BSV-21 id (`txid_vout`); null for a BSV-20 v1 tick. */
  id: string | null
  tick: string | null
  sym: string
  dec: number
  icon: string | null
  /** Confirmed + pending, base units, decimal string. */
  amount: string
  /** Part of `amount` locked in a market listing — not P2PKH, not sweepable. */
  listed: string
  standard: TokenStandard
}

export type AddressHoldings = {
  address: string
  path: string
  label: string
  wallets: string
  uncompressed: boolean
  cashSats: number
  cashCount: number
  /** Outputs too small to pay their own way, left where they are. */
  dustCount: number
  /** Absent on scans saved before it was recorded. */
  dustSats?: number
  itemCount: number
  itemCountCapped: boolean
  tokens: TokenHolding[]
  /** Set when a provider could not answer; counts are then a floor. */
  error: string | null
}

/** Why an asset is shown but never swept. */
export type ImportHoldReason =
  | 'uncompressed'
  | 'dust'
  | 'bsv20v1'
  | 'listed'
  | 'cosigned'
  | 'tokenPending'
  | 'tokenInvalid'
  | 'tokenUnreadable'
  | 'runJig'
  | 'covenant'
  | 'foreign'
  | 'token'
  | 'notOneSat'
  | 'notCollectable'
  | 'unreadable'

export function describeImportHold(reason: ImportHoldReason): string {
  switch (reason) {
    case 'uncompressed':
      return 'Held by the uncompressed form of the key — this wallet signs compressed, so it stays put.'
    case 'dust':
      return 'Worth less than the fee to move it.'
    case 'bsv20v1':
      return 'BSV-20 tick token — this wallet holds BSV-21 only.'
    case 'listed':
      return 'Listed for sale in a market contract — cancel the listing at the source first.'
    case 'cosigned':
      return 'Needs the issuer’s cosignature (e.g. MNEE) — stays at the source.'
    case 'tokenPending':
      return 'The token indexer has not validated it yet — rescan later.'
    case 'tokenInvalid':
      return 'Not a valid token output — moving it would burn the tokens beside it.'
    case 'tokenUnreadable':
      return 'Its script does not match what the indexer reported — left untouched.'
    case 'runJig':
      return 'RUN jig — moving it as a plain output destroys it.'
    case 'covenant':
      return 'Locked by a contract (e.g. a 2-of-2 Sigil) — not a plain item.'
    case 'foreign':
      return 'Locked to another key.'
    case 'token':
      return 'Token output — moved by the token sweep, not as an item.'
    case 'notOneSat':
      return 'Not a 1-sat output.'
    case 'notCollectable':
      return 'Not a plain collectable (RUN jig, contract, token or cash) — left at the source.'
    case 'unreadable':
      return 'Its source transaction could not be fetched.'
  }
}

export type HeldTally = Partial<Record<ImportHoldReason, number>>

export function addHeld(tally: HeldTally, reason: ImportHoldReason, count = 1): HeldTally {
  if (count <= 0) return tally
  return { ...tally, [reason]: (tally[reason] ?? 0) + count }
}

export type HoldingsTotals = {
  cashSats: number
  cashCount: number
  itemCount: number
  itemCountCapped: boolean
  /** Compatible BSV-21 balances, summed per id across addresses. */
  tokens: TokenHolding[]
  held: HeldTally
  /** Addresses whose numbers are a floor because a provider failed. */
  partial: number
}

function gorillaBase(chain: Chain): string {
  return chain === 'main'
    ? 'https://ordinals.gorillapool.io'
    : 'https://testnet.ordinals.gorillapool.io'
}

const PREVIEW_ITEM_CAP = 5_000

function digits(value: unknown): string {
  const s = typeof value === 'number' ? String(Math.trunc(value)) : String(value ?? '')
  return /^\d+$/.test(s) ? s : '0'
}

function addAmounts(a: string, b: string): string {
  return (BigInt(digits(a)) + BigInt(digits(b))).toString()
}

/** Token balances from the 1Sat index. Never rejects — tokens are an enrichment. */
export async function fetchTokenBalances(
  address: string,
  chain: Chain,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenHolding[]> {
  const res = await fetchImpl(
    `${gorillaBase(chain)}/api/bsv20/${encodeURIComponent(address)}/balance`,
    { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) },
  )
  if (!res.ok) throw new Error(`Token index ${res.status}`)
  const body = (await res.json()) as unknown
  if (!Array.isArray(body)) return []
  return body.flatMap((row: Record<string, unknown>): TokenHolding[] => {
    const all = (row.all ?? {}) as { confirmed?: unknown; pending?: unknown }
    const listed = (row.listed ?? {}) as { confirmed?: unknown; pending?: unknown }
    const amount = addAmounts(digits(all.confirmed), digits(all.pending))
    if (amount === '0') return []
    const id = typeof row.id === 'string' && row.id ? row.id : null
    const tick = typeof row.tick === 'string' && row.tick ? row.tick : null
    return [
      {
        id,
        tick,
        sym: String(row.sym ?? tick ?? id?.slice(0, 8) ?? 'token'),
        dec: Number.isInteger(row.dec) ? Number(row.dec) : 0,
        icon: typeof row.icon === 'string' && row.icon ? row.icon : null,
        amount,
        listed: addAmounts(digits(listed.confirmed), digits(listed.pending)),
        standard: id ? 'bsv21' : 'bsv20',
      },
    ]
  })
}

export async function inspectAddressHoldings(
  discovered: DiscoveredAddress,
  chain: Chain,
): Promise<AddressHoldings> {
  const out: AddressHoldings = {
    address: discovered.address,
    path: discovered.path,
    label: discovered.label,
    wallets: discovered.wallets,
    uncompressed: discovered.uncompressed === true,
    cashSats: 0,
    cashCount: 0,
    dustCount: 0,
    dustSats: 0,
    itemCount: 0,
    itemCountCapped: false,
    tokens: [],
    error: null,
  }
  const errors: string[] = []
  try {
    const scan = await scanAddressAny(discovered.address, chain)
    for (const utxo of scan.utxos) {
      const path = chooseLegacySweepPath(utxo)
      if (path.path === 'sweep') {
        out.cashSats += utxo.satoshis
        out.cashCount += 1
      } else if (path.reason === 'uneconomical') {
        out.dustCount += 1
        out.dustSats = (out.dustSats ?? 0) + utxo.satoshis
      }
    }
    // Transferred items are plain 1-sat P2PKH; minted ones only the ord index sees.
    const items = await countOrdinalsAtLeast(discovered.address, chain, PREVIEW_ITEM_CAP)
    out.itemCount = items.count
    out.itemCountCapped = items.capped
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }
  try {
    out.tokens = await fetchTokenBalances(discovered.address, chain)
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }
  out.error = errors.length > 0 ? errors.join('; ') : null
  return out
}

export async function inspectHoldings(args: {
  addresses: DiscoveredAddress[]
  chain: Chain
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}): Promise<AddressHoldings[]> {
  const startedAt = Date.now()
  const out: AddressHoldings[] = []
  for (const [i, address] of args.addresses.entries()) {
    if (args.shouldStop?.()) break
    await yieldToUi()
    out.push(await inspectAddressHoldings(address, args.chain))
    args.onProgress?.(i + 1, args.addresses.length)
  }
  appendAppLog(
    'info',
    `[import] holdings done ${Date.now() - startedAt}ms addresses=${out.length}`,
  )
  return out
}

/** Roll per-address holdings into what a sweep can and cannot move. */
export function totalHoldings(holdings: readonly AddressHoldings[]): HoldingsTotals {
  let held: HeldTally = {}
  let cashSats = 0
  let cashCount = 0
  let itemCount = 0
  let itemCountCapped = false
  let partial = 0
  const tokens = new Map<string, TokenHolding>()
  for (const h of holdings) {
    if (h.error) partial += 1
    held = addHeld(held, 'dust', h.dustCount)
    if (h.uncompressed) {
      held = addHeld(held, 'uncompressed', h.cashCount + h.itemCount + h.tokens.length)
      continue
    }
    cashSats += h.cashSats
    cashCount += h.cashCount
    itemCount += h.itemCount
    itemCountCapped ||= h.itemCountCapped
    for (const token of h.tokens) {
      if (token.standard === 'bsv20' || !token.id) {
        held = addHeld(held, 'bsv20v1')
        continue
      }
      if (token.listed !== '0') held = addHeld(held, 'listed')
      const free = (BigInt(token.amount) - BigInt(token.listed)).toString()
      if (BigInt(free) <= 0n) continue
      const prior = tokens.get(token.id)
      tokens.set(
        token.id,
        prior
          ? { ...prior, amount: addAmounts(prior.amount, free) }
          : { ...token, amount: free, listed: '0' },
      )
    }
  }
  return {
    cashSats,
    cashCount,
    itemCount,
    itemCountCapped,
    tokens: [...tokens.values()],
    held,
    partial,
  }
}

/** `1234500` with 2 decimals → `12345`. Trailing zeros trimmed. */
export function formatTokenAmount(amount: string, dec: number): string {
  const raw = digits(amount).replace(/^0+(?=\d)/, '')
  if (dec <= 0) return BigInt(raw).toLocaleString()
  const padded = raw.padStart(dec + 1, '0')
  const whole = BigInt(padded.slice(0, -dec)).toLocaleString()
  const frac = padded.slice(-dec).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}
