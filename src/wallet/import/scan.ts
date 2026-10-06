import { getWalletRuntime } from '../walletRuntime'
import { assertOnlineForPayment } from '../paymentPolicy'
import { appendAppLog } from '../appLog'
import type { Chain } from '../vault'
import {
  discoverAddresses,
  gorillaItemsLookup,
  wocHistoryLookup,
  type HistoryLookup,
  type ItemsLookup,
} from './discovery'
import { addCashOutput, emptyHoldings, inspectHoldings, type AddressHoldings } from './holdings'
import { fetchHandCashUtxoSet, readUnspentCash, readUnspentOutpoints, verifyUtxoSet } from './handcashUtxoSet'
import { keyDeriverFor, type KeyDeriver } from './importSource'
import { readMneeBalances } from '../mnee'
import { MNEE_DECIMALS, MNEE_SYMBOL, MNEE_TOKEN_ID, isMneeTokenId } from '../mneeTip'
import { itemsFromOutpoints, knownAddresses, rememberImportItems } from './items'
import {
  createHistoryReader,
  hintedLookups,
  judgeHintedScan,
  readItemOwners,
  recoveryHintsFor,
  type HandCashRecoveryHints,
  type HintVerdict,
} from './recoveryHints'
import { loadImportedSources, updateImportedSource, type ImportedSource, type SourceScan } from './store'

export type ScanProgress =
  | { phase: 'utxoSet'; fetched: number }
  | { phase: 'cash'; done: number; total: number }
  | { phase: 'items'; done: number; total: number }
  | { phase: 'history'; done: number; total: number }
  | { phase: 'discover'; checked: number; found: number; walk: string }
  | { phase: 'holdings'; done: number; total: number }

type ScanArgs = {
  sourceId: string
  /** Overrides each template's gap — a quick look or a deeper walk. */
  gap?: number
  onProgress?: (progress: ScanProgress) => void
  shouldStop?: () => boolean
}

/**
 * Walk a saved source's key set, then read what each used address holds.
 * Read-only: nothing is signed or broadcast. The result is saved on the source.
 *
 * A HandCash source with recovery hints from the migrate page is first walked
 * against the outputs of its own history. That pass stands only when the chain
 * shows everything HandCash reports; otherwise the full network walk runs.
 */
export async function scanImportedSource(args: ScanArgs): Promise<ImportedSource> {
  const active = getWalletRuntime()?.instance
  if (!active) throw new Error('Unlock this wallet first')
  assertOnlineForPayment()
  const source = (await loadImportedSources()).find((s) => s.id === args.sourceId)
  if (!source) throw new Error('That saved wallet is gone')

  const deriver = keyDeriverFor(source.secret)
  const hints = args.gap == null ? recoveryHintsFor(source) : null
  const cache = new Map<string, AddressHoldings>()
  const scan =
    (args.gap == null && source.secret.kind === 'handcash'
      ? await utxoSetScan(deriver, active.chain, args, cache, knownAddresses(source))
      : null) ??
    (hints ? await hintedScan(deriver, active.chain, hints, args, cache) : null) ??
    (await walkScan(
      deriver,
      active.chain,
      args,
      { history: wocHistoryLookup(active.chain), items: gorillaItemsLookup(active.chain) },
      undefined,
      cache,
    ))
  const saved = await updateImportedSource(source.id, { scan })
  if (!saved) throw new Error('That saved wallet was removed during the scan')
  return saved
}

async function walkScan(
  deriver: KeyDeriver,
  chain: Chain,
  args: ScanArgs,
  lookups: { history: HistoryLookup; items: ItemsLookup },
  mayHold?: ReadonlySet<string>,
  cache?: Map<string, AddressHoldings>,
): Promise<SourceScan> {
  const discovered = await discoverAddresses({
    deriver,
    ...lookups,
    ...(args.gap != null ? { gap: args.gap } : {}),
    onProgress: (p) => args.onProgress?.({ phase: 'discover', ...p }),
    shouldStop: args.shouldStop,
  })
  const holdings = await inspectHoldings({
    addresses: discovered.addresses,
    chain,
    ...(mayHold ? { mayHold } : {}),
    ...(cache ? { cache } : {}),
    onProgress: (done, total) => args.onProgress?.({ phase: 'holdings', done, total }),
    shouldStop: args.shouldStop,
  })
  return {
    at: Date.now(),
    complete: discovered.complete && holdings.length === discovered.addresses.length,
    checked: discovered.checked,
    addresses: discovered.addresses,
    holdings,
  }
}

/**
 * The HandCash export read from its own account's UTXO set, or null when the
 * set cannot be had and the hinted pass or full walk must run instead.
 *
 * Rows count only when the keys derive their path to their address. Cash and
 * token addresses are read live; one-sat items are counted by outpoint where
 * the 1Sat index shows them unspent.
 */
export async function utxoSetScan(
  deriver: KeyDeriver,
  chain: Chain,
  args: ScanArgs,
  cache: Map<string, AddressHoldings> = new Map(),
  known?: ReadonlyMap<string, string>,
): Promise<SourceScan | null> {
  const set = await fetchHandCashUtxoSet({
    deriver,
    onProgress: (fetched) => args.onProgress?.({ phase: 'utxoSet', fetched }),
    shouldStop: args.shouldStop,
  })
  if (set.kind === 'refused') return null
  const verified = await verifyUtxoSet(deriver, set.utxos, known)
  if (set.utxos.length > 0 && verified.addresses.length === 0) {
    appendAppLog('warn', `[import] utxo set refused reason=underived rows=${set.utxos.length} — falling back`)
    return null
  }
  const cash = await readUnspentCash({
    chain,
    outputs: [...verified.cashOutputs.values()].flat(),
    onProgress: (done, total) => args.onProgress?.({ phase: 'cash', done, total }),
    shouldStop: args.shouldStop,
  })
  const items = await readUnspentOutpoints({
    chain,
    outpoints: [...verified.itemOutpoints.values()].flat(),
    onProgress: (done, total) => args.onProgress?.({ phase: 'items', done, total }),
    shouldStop: args.shouldStop,
  })
  const readAddresses = new Set(verified.readAddresses)
  for (const [address, outputs] of verified.cashOutputs) {
    if (outputs.some((o) => cash.unknown.has(o.outpoint))) readAddresses.add(address)
  }
  const toRead = verified.addresses.filter((a) => readAddresses.has(a.address))
  const read = await inspectHoldings({
    addresses: toRead,
    chain,
    cache,
    onProgress: (done, total) => args.onProgress?.({ phase: 'holdings', done, total }),
    shouldStop: args.shouldStop,
  })
  const byAddress = new Map(read.map((h) => [h.address, h]))
  const holdings = verified.addresses.map((address) => {
    const live = byAddress.get(address.address)
    if (live) return live
    const out = emptyHoldings(address)
    for (const o of verified.cashOutputs.get(address.address) ?? []) {
      if (cash.unspent.has(o.outpoint)) addCashOutput(out, o)
    }
    out.itemCount = (verified.itemOutpoints.get(address.address) ?? []).filter((o) => items.unspent.has(o)).length
    return out
  })
  await addMneeHoldings(holdings, verified.mneeAddresses)
  const stopped = cash.stopped || items.stopped || args.shouldStop?.() === true || read.length < toRead.length
  const at = Date.now()
  rememberImportItems(args.sourceId, at, itemsFromOutpoints(verified.itemOutpoints, items))
  return {
    at,
    complete: !stopped && items.failed === 0,
    checked: verified.addresses.length,
    addresses: verified.addresses,
    holdings,
    via: 'handcash-utxo-set',
  }
}

/**
 * MNEE balances from MNEE's own index, replacing any 1Sat-index guess. A
 * failed read marks those addresses partial rather than showing zero.
 */
async function addMneeHoldings(holdings: AddressHoldings[], addresses: ReadonlySet<string>): Promise<void> {
  if (addresses.size === 0) return
  let balances: Map<string, bigint>
  try {
    balances = await readMneeBalances([...addresses])
  } catch (err) {
    const reason = `MNEE index: ${err instanceof Error ? err.message : String(err)}`
    for (const h of holdings) {
      if (addresses.has(h.address)) h.error = h.error ? `${h.error}; ${reason}` : reason
    }
    return
  }
  for (const h of holdings) {
    if (!addresses.has(h.address)) continue
    const amount = balances.get(h.address) ?? 0n
    h.tokens = [
      ...h.tokens.filter((t) => !isMneeTokenId(t.id)),
      ...(amount > 0n
        ? [
            {
              id: MNEE_TOKEN_ID,
              tick: null,
              sym: MNEE_SYMBOL,
              dec: MNEE_DECIMALS,
              icon: null,
              amount: amount.toString(),
              listed: '0',
              standard: 'bsv21' as const,
            },
          ]
        : []),
    ]
  }
}

/** History windows, newest first: most HandCash balances sit in recent outputs. */
const HISTORY_WINDOWS = [500, 2_500]

/**
 * The hinted pass, or null when the full walk must run instead.
 *
 * Only the unspent set matters. Items are located by origin in the 1Sat index;
 * cash by reading history newest first in widening windows until the chain
 * shows what HandCash reports. Addresses every read output of which was spent
 * by a read transaction are not read again; the rest are read once per scan,
 * and a fallback walk reuses those reads.
 */
export async function hintedScan(
  deriver: KeyDeriver,
  chain: Chain,
  hints: HandCashRecoveryHints,
  args: ScanArgs,
  cache: Map<string, AddressHoldings> = new Map(),
): Promise<SourceScan | null> {
  if (hints.satoshis === 0 && hints.itemCount === 0) {
    appendAppLog('info', '[import] hinted scan refused reason=empty-claim — full walk')
    return null
  }
  const items =
    hints.origins.length > 0
      ? await readItemOwners({
          chain,
          origins: hints.origins,
          onProgress: (done, total) => args.onProgress?.({ phase: 'items', done, total }),
          shouldStop: args.shouldStop,
        })
      : null
  const history = createHistoryReader({ chain, txids: hints.txids })
  const limits = [...HISTORY_WINDOWS.filter((n) => n < hints.txids.length), hints.txids.length]
  let verdict: HintVerdict = { kind: 'fallback', reason: 'balance-short' }
  for (const limit of limits) {
    await history.readUntil(limit, {
      onProgress: (done, total) => args.onProgress?.({ phase: 'history', done, total }),
      shouldStop: args.shouldStop,
    })
    const read = history.snapshot()
    const owners = items?.owners ?? new Set<string>()
    const seen = new Set([...read.addresses, ...owners])
    const mayHold = new Set([...read.mayHold, ...owners])
    const scan = await walkScan(deriver, chain, args, hintedLookups(seen), mayHold, cache)
    if (args.shouldStop?.()) return { ...scan, complete: false }
    verdict = judgeHintedScan(hints, { stopped: read.stopped || items?.stopped === true }, scan.holdings)
    appendAppLog(
      'info',
      `[import] hinted window txs=${history.position}/${hints.txids.length} mayHold=${mayHold.size} used=${scan.addresses.length} verdict=${verdict.kind === 'settled' ? 'settled' : verdict.reason}`,
    )
    if (verdict.kind === 'settled') {
      appendAppLog(
        'info',
        `[import] hinted scan settled sats=${verdict.foundSats} items=${verdict.foundItems} of sats=${hints.satoshis} items=${hints.itemCount}`,
      )
      return { ...scan, via: 'handcash-history' }
    }
    if (verdict.reason === 'stopped') break
  }
  appendAppLog('info', `[import] hinted scan refused reason=${verdict.kind === 'fallback' ? verdict.reason : 'settled'} — full walk`)
  return null
}
