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
 * is: plain cash and 1-sat collectables. Everything else, tokens included,
 * stays at the source with a named reason. Nothing here spends.
 */

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
  /** Set when a provider could not answer; counts are then a floor. */
  error: string | null
}

/** Why an asset is shown but never swept. */
export type ImportHoldReason =
  | 'uncompressed'
  | 'dust'
  | 'runJig'
  | 'covenant'
  | 'foreign'
  | 'token'
  | 'notOneSat'
  | 'notCollectable'
  | 'unreadable'

/** Null for a reason older saves recorded that no longer applies. */
export function describeImportHold(reason: string): string | null {
  switch (reason) {
    case 'uncompressed':
      return 'Held by the uncompressed form of the key — this wallet signs compressed, so it stays put.'
    case 'dust':
      return 'Worth less than the fee to move it.'
    case 'runJig':
      return 'RUN jig — moving it as a plain output destroys it.'
    case 'covenant':
      return 'Locked by a contract (e.g. a 2-of-2 Sigil) — not a plain item.'
    case 'foreign':
      return 'Locked to another key.'
    case 'token':
      return 'Token output — this wallet does not import tokens, so it stays at the source.'
    case 'notOneSat':
      return 'Not a 1-sat output.'
    case 'notCollectable':
      return 'Not a plain collectable (RUN jig, contract, token or cash) — left at the source.'
    case 'unreadable':
      return 'Its source transaction could not be fetched.'
    default:
      return null
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
  held: HeldTally
  /** Addresses whose numbers are a floor because a provider failed. */
  partial: number
}

const PREVIEW_ITEM_CAP = 5_000

/** A used address with nothing on it — what a fully spent address reads as. */
export function emptyHoldings(discovered: DiscoveredAddress): AddressHoldings {
  return {
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
    error: null,
  }
}

/** Count one unspent plain output as cash or dust; anything else is not cash. */
export function addCashOutput(out: AddressHoldings, utxo: { satoshis: number }): void {
  const path = chooseLegacySweepPath(utxo)
  if (path.path === 'sweep') {
    out.cashSats += utxo.satoshis
    out.cashCount += 1
  } else if (path.reason === 'uneconomical') {
    out.dustCount += 1
    out.dustSats = (out.dustSats ?? 0) + utxo.satoshis
  }
}

export async function inspectAddressHoldings(
  discovered: DiscoveredAddress,
  chain: Chain,
): Promise<AddressHoldings> {
  const out = emptyHoldings(discovered)
  const errors: string[] = []
  try {
    const scan = await scanAddressAny(discovered.address, chain)
    for (const utxo of scan.utxos) addCashOutput(out, utxo)
    // Transferred items are plain 1-sat P2PKH; minted ones only the ord index sees.
    const items = await countOrdinalsAtLeast(discovered.address, chain, PREVIEW_ITEM_CAP)
    out.itemCount = items.count
    out.itemCountCapped = items.capped
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
  }
  out.error = errors.length > 0 ? errors.join('; ') : null
  return out
}

/**
 * Read what each discovered address holds. With `mayHold`, an address outside
 * it is known to hold nothing (every output it ever received was spent by a
 * transaction the chain returned) and reads as empty without a network call.
 */
export async function inspectHoldings(args: {
  addresses: DiscoveredAddress[]
  chain: Chain
  mayHold?: ReadonlySet<string>
  /** Reads already made in this scan, reused by address. */
  cache?: Map<string, AddressHoldings>
  onProgress?: (done: number, total: number) => void
  shouldStop?: () => boolean
}): Promise<AddressHoldings[]> {
  const startedAt = Date.now()
  const out: AddressHoldings[] = []
  let read = 0
  for (const [i, address] of args.addresses.entries()) {
    if (args.shouldStop?.()) break
    if (args.mayHold && !args.mayHold.has(address.address)) {
      out.push(emptyHoldings(address))
      continue
    }
    const cached = args.cache?.get(address.address)
    if (cached) {
      out.push(cached)
      continue
    }
    await yieldToUi()
    const holding = await inspectAddressHoldings(address, args.chain)
    if (!holding.error) args.cache?.set(address.address, holding)
    out.push(holding)
    read += 1
    args.onProgress?.(i + 1, args.addresses.length)
  }
  appendAppLog(
    'info',
    `[import] holdings done ${Date.now() - startedAt}ms addresses=${out.length} read=${read}`,
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
  for (const h of holdings) {
    if (h.error) partial += 1
    held = addHeld(held, 'dust', h.dustCount)
    if (h.uncompressed) {
      held = addHeld(held, 'uncompressed', h.cashCount + h.itemCount)
      continue
    }
    cashSats += h.cashSats
    cashCount += h.cashCount
    itemCount += h.itemCount
    itemCountCapped ||= h.itemCountCapped
  }
  return {
    cashSats,
    cashCount,
    itemCount,
    itemCountCapped,
    held,
    partial,
  }
}
