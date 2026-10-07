import { getActiveWallet } from './session'

/**
 * Import another BIP39 phrase into the unlocked wallet.
 *
 * 1. Derive BRC-75 + legacy-HD roots; pick the address that holds UTXOs.
 * 2. Sweep funding (satoshis ≥ sweep floor) into this wallet — signed with the
 *    foreign key, change credited to the active identity.
 * 3. Move chosen 1-sat items in shared transactions (`itemMigrateRunMachine`).
 */
import { createActor } from 'xstate'
import { Beef, P2PKH, PrivateKey, type BEEF, type LockingScript } from '@bsv/sdk'
import {
  keyFromMnemonicHdPath,
  rootKeyFromMnemonicBrc75,
  rootKeyFromMnemonicLegacyHd,
  type Chain,
} from './vault'
import { appendAppLog } from './appLog'
import { type ActiveWallet } from './session'
import {
  importLegacyUtxos,
  scanAddressViaBitails,
  scanAddressViaWhatsOnChain,
  type LegacyScanResult,
  type LegacyUtxo,
} from './legacyScan'
import { chooseLegacySweepPath } from './legacySweepPath'
import { runJigVouts } from './legacyAssetScript'
import { buildLegacyInputBeef } from './legacyBeef'
import { forgetLegacyImported, legacySweepRecord } from './legacyImportGuard'
import { retryableStuckSweeps } from './legacyStuckSweep'
import {
  recordFundingReceipts,
  recordMigratedItemActivity,
  type MigratedItemReceipt,
} from './legacyReceiptActivity'
import { itemMigrateTxDescription } from './activityJobIndex'
import {
  chooseOrdinalMigratePath,
  describeOrdinalMigrateSkip,
  type OrdinalMigrateSkipReason,
} from './ordinalMigratePath'
import {
  MAX_ITEMS_PER_MIGRATE_TX,
  chooseItemMigrateUnit,
  itemsWithinPostBudget,
  migrateInputBeef,
  migrateTipPostBytes,
} from './itemMigrateBundle'
import {
  ITEM_MIGRATE_STOP_MESSAGES,
  classifyItemMigrateFault,
  type ItemMigrateFault,
  type ItemMigrateStop,
} from './itemMigrateRun'
import { itemMigrateRunMachine } from './itemMigrateRunMachine'
import { postForeignInputAction, type ForeignInputPosted } from './foreignInputAction'
import { setVisibleTimeout } from './visibleClock'
import { yieldToUi } from './yieldToUi'
import { runExclusiveSpend, yieldToForegroundSpends } from './spendGuard'
import { assertOnlineForPayment } from './paymentPolicy'
import { buildInternalizeCustomInstructions } from './oneSatProvenance'
import { refreshFromChain } from './chainIngest'
import { scheduleHistoryBackupPush } from './deviceSync'

const GP_PAGE = 50
/** Soft preview cap — full count continues during migrate. */
const PREVIEW_ITEM_CAP = 5_000

/** Toolbox `defaultOptions().feeModel` — mirror it so estimates match reality. */
const DEFAULT_FEE_SAT_PER_KB = 100
const P2PKH_INPUT_BYTES = 148
const P2PKH_OUTPUT_BYTES = 34
const TX_OVERHEAD_BYTES = 10

export type ItemMigrateEstimate = {
  transactions: number
  feeSats: number
}

/**
 * What a full item migration costs this wallet, in transactions and fees.
 *
 * At ordinal scale the answer changes the decision — an 800k collection is tens
 * of thousands of transactions and a non-trivial fee budget — and a run that
 * halts partway for want of change reads as a failure unless the budget was
 * stated up front. Sizing follows the shape `migrateOrdinalUnit` builds: one
 * P2PKH input per tip plus a funding input, one 1-sat output per tip plus
 * change.
 */
export function estimateItemMigrateCost(args: {
  itemCount: number
  itemsPerTx?: number
  feeRateSatPerKb?: number
}): ItemMigrateEstimate {
  const items = Math.max(0, Math.trunc(args.itemCount))
  if (items === 0) return { transactions: 0, feeSats: 0 }
  const perTx = Math.max(
    1,
    Math.min(args.itemsPerTx ?? MAX_ITEMS_PER_MIGRATE_TX, MAX_ITEMS_PER_MIGRATE_TX),
  )
  const rate = Math.max(0, args.feeRateSatPerKb ?? DEFAULT_FEE_SAT_PER_KB)
  const fullTransactions = Math.floor(items / perTx)
  const remainder = items % perTx
  const transactionFee = (tipCount: number) => {
    const bytes =
      (tipCount + 1) * P2PKH_INPUT_BYTES +
      (tipCount + 1) * P2PKH_OUTPUT_BYTES +
      TX_OVERHEAD_BYTES
    return Math.ceil((bytes / 1000) * rate)
  }
  const transactions = fullTransactions + (remainder > 0 ? 1 : 0)
  const feeSats =
    fullTransactions * transactionFee(perTx) + (remainder > 0 ? transactionFee(remainder) : 0)
  return { transactions, feeSats }
}

export type PhraseScheme =
  | 'brc-75'
  | 'legacy-hd'
  | 'centi-receive'
  | 'centi-change'
  | 'yours-wallet'
  | 'yours-ord'
  | 'yours-relayx-ord'
  | 'yours-sweep'
  | 'yours-identity'
  | 'twetch'
  /** A key from a saved Import section source. */
  | 'import'

export type PhraseCandidate = {
  scheme: PhraseScheme
  /** Human label for the source branch, e.g. "Yours ordinals". */
  label: string
  /** BIP32 path, or `brc75` / `m` for the seed-root schemes. */
  path: string
  rootKeyHex: string
  identityKey: string
  address: string
}

/**
 * One derivation that actually held value. A phrase can light up several at
 * once — Yours keeps cash on one branch and ordinals on another — so a preview
 * is a set of hits, not a single "best" address.
 */
export type PhraseSourceHit = {
  candidate: PhraseCandidate
  scan: LegacyScanResult
  fundingSats: number
  fundingCount: number
  itemCountAtLeast: number
  itemCountCapped: boolean
}

export type PhraseSweepPreview = {
  /** Only derivations with sweepable BSV or items. */
  hits: PhraseSourceHit[]
  /** Representative candidate for display (most valuable hit, else BRC-75). */
  primary: PhraseCandidate
  /** Aggregate across every hit. */
  fundingSats: number
  fundingCount: number
  itemCountAtLeast: number
  itemCountCapped: boolean
  /** True when a hit derivation equals the active identity (nothing to move). */
  sameAsActive: boolean
}

/** Known foreign-wallet derivation branches (Yours / RelayX / Twetch). */
const HD_BRANCHES: Array<{ scheme: PhraseScheme; label: string; path: string }> = [
  { scheme: 'yours-ord', label: 'Yours ordinals', path: "m/44'/236'/1'/0/0" },
  { scheme: 'yours-wallet', label: 'Yours wallet', path: "m/44'/236'/0'/1/0" },
  { scheme: 'yours-sweep', label: 'Yours imported', path: "m/44'/236'/0'/0/0" },
  { scheme: 'yours-relayx-ord', label: 'RelayX ordinals', path: "m/44'/236'/0'/2/0" },
  { scheme: 'yours-identity', label: 'Yours identity', path: "m/0'/236'/0'/0/0" },
  { scheme: 'twetch', label: 'Twetch', path: 'm/0/0' },
]

/**
 * Centi tester-confirmed BIP44 account.
 *
 * `m/44'/145'/0'/0` is a receive *chain*, not an address: its spendable leaves
 * are `/0`, `/1`, … and change normally lives under sibling chain `/1`. Until
 * Centi documents a gap limit, inspect the first twenty of each explicitly.
 * That is bounded, deterministic support rather than an unbounded derivation
 * walk that could keep a recovery screen busy forever.
 */
export const CENTI_ADDRESS_COUNT = 20
const CENTI_ACCOUNT_PATH = "m/44'/145'/0'"

export function buildCentiPhraseCandidates(
  mnemonic: string,
  passphrase = '',
  count = CENTI_ADDRESS_COUNT,
): PhraseCandidate[] {
  const limit = Math.max(0, Math.min(CENTI_ADDRESS_COUNT, Math.trunc(count)))
  const out: PhraseCandidate[] = []
  const branches = [
    { scheme: 'centi-receive' as const, label: 'Centi receive', chain: 0 },
    { scheme: 'centi-change' as const, label: 'Centi change', chain: 1 },
  ]
  for (const branch of branches) {
    for (let index = 0; index < limit; index += 1) {
      const path = `${CENTI_ACCOUNT_PATH}/${branch.chain}/${index}`
      const derived = keyFromMnemonicHdPath(mnemonic, path, passphrase)
      out.push({
        scheme: branch.scheme,
        label: `${branch.label} #${index}`,
        path,
        rootKeyHex: derived.rootKeyHex,
        identityKey: derived.identityKey,
        address: derived.address,
      })
    }
  }
  return out
}

/** Derive every address a foreign phrase might hold value on. */
function buildPhraseCandidates(
  mnemonic: string,
  passphrase: string,
): PhraseCandidate[] {
  const out: PhraseCandidate[] = []
  const seen = new Set<string>()
  const push = (c: PhraseCandidate) => {
    const key = c.address.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(c)
  }

  try {
    const d = rootKeyFromMnemonicBrc75(mnemonic, passphrase)
    push({
      scheme: 'brc-75',
      label: 'BRC-75 (HandCash / Yours)',
      path: 'brc75',
      rootKeyHex: d.rootKeyHex,
      identityKey: d.identityKey,
      address: d.address,
    })
  } catch {
    /* invalid phrase handled by validate */
  }

  try {
    const d = rootKeyFromMnemonicLegacyHd(mnemonic, passphrase)
    push({
      scheme: 'legacy-hd',
      label: 'HD master',
      path: 'm',
      rootKeyHex: d.rootKeyHex,
      identityKey: d.identityKey,
      address: d.address,
    })
  } catch {
    /* ignore */
  }

  for (const branch of HD_BRANCHES) {
    try {
      const d = keyFromMnemonicHdPath(mnemonic, branch.path, passphrase)
      push({
        scheme: branch.scheme,
        label: branch.label,
        path: branch.path,
        rootKeyHex: d.rootKeyHex,
        identityKey: d.identityKey,
        address: d.address,
      })
    } catch {
      /* skip branches the SDK cannot derive */
    }
  }

  return out
}

export type PhraseFundingSweepResult = {
  imported: number
  failed: number
  fundingSatsMoved: number
  errors: string[]
  /**
   * Outputs a previous sweep already claimed. Distinct from "nothing to sweep":
   * the coins were found on the address, but the durable import guard holds a
   * mark for them, so they are either already in this wallet or waiting on a
   * broadcast that has not yet been proven missing.
   */
  alreadySwept: number
}

function gorillaBase(chain: Chain): string {
  return chain === 'main'
    ? 'https://ordinals.gorillapool.io'
    : 'https://testnet.ordinals.gorillapool.io'
}

function normalizeMnemonic(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

function wordCount(mnemonic: string): number {
  return mnemonic.split(' ').filter(Boolean).length
}

export function validatePhraseInput(raw: string): string | null {
  const mnemonic = normalizeMnemonic(raw)
  const n = wordCount(mnemonic)
  if (n !== 12 && n !== 24) {
    return 'Enter a 12- or 24-word recovery phrase'
  }
  try {
    rootKeyFromMnemonicBrc75(mnemonic)
  } catch {
    return 'That phrase is not a valid BIP39 mnemonic'
  }
  return null
}

export async function scanAddressAny(
  address: string,
  chain: Chain,
): Promise<LegacyScanResult> {
  try {
    return await scanAddressViaBitails(address, chain)
  } catch {
    /* fall through */
  }
  return scanAddressViaWhatsOnChain(address, chain)
}

/**
 * Count only 1-sat tips.
 *
 * The indexer lists every unspent output for the address, so counting rows made
 * the preview promise cash outputs as collectables.
 */
export async function countOrdinalsAtLeast(
  address: string,
  chain: Chain,
  cap: number,
): Promise<{ count: number; capped: boolean }> {
  let offset = 0
  let count = 0
  while (count < cap) {
    const page = await fetchOrdinalPage(address, chain, offset)
    if (page.rawCount === 0) return { count, capped: false }
    count += page.rows.filter((r) => r.satoshis === 1).length
    if (page.rawCount < GP_PAGE) return { count, capped: false }
    offset += page.rawCount
    await yieldToUi()
  }
  return { count, capped: true }
}

type OrdinalRow = { outpoint: string; origin: string; satoshis: number }

/**
 * One indexer page. `rawCount` is what the indexer returned — the cursor must
 * advance by that, never by the filtered subset, or unvisited rows are skipped.
 */
type OrdinalPage = { rows: OrdinalRow[]; rawCount: number }

async function fetchOrdinalPage(
  address: string,
  chain: Chain,
  offset: number,
): Promise<OrdinalPage> {
  const url =
    `${gorillaBase(chain)}/api/txos/address/${encodeURIComponent(address)}/unspent` +
    `?limit=${GP_PAGE}&offset=${offset}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Ordinal index ${res.status}`)
  }
  const body = (await res.json()) as unknown
  if (!Array.isArray(body)) return { rows: [], rawCount: 0 }
  const rows = (body as Array<Record<string, unknown>>).flatMap((r): OrdinalRow[] => {
    const rawOp =
      typeof r.outpoint === 'string'
        ? r.outpoint
        : typeof r.txid === 'string' && typeof r.vout === 'number'
          ? `${r.txid}_${r.vout}`
          : ''
    const outpoint = rawOp.replace(/_(\d+)$/, '.$1').toLowerCase()
    if (!outpoint.includes('.')) return []
    const originRaw =
      r.origin && typeof r.origin === 'object'
        ? (r.origin as { outpoint?: string }).outpoint
        : undefined
    const origin =
      typeof originRaw === 'string' ? originRaw.replace(/_(\d+)$/, '.$1') : outpoint
    const satoshis = Number(r.satoshis ?? 0)
    return [{ outpoint, origin, satoshis: Number.isFinite(satoshis) ? satoshis : 0 }]
  })
  return { rows, rawCount: body.length }
}

/**
 * Preview every derivation the phrase might hold value on. Does not spend.
 *
 * Foreign wallets split cash and ordinals across separate BIP44 branches, so
 * this scans all known branches and returns each that has funds or items.
 */
export async function previewPhraseSweep(
  mnemonicRaw: string,
  passphrase = '',
): Promise<PhraseSweepPreview> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock this wallet first')
  assertOnlineForPayment()

  const err = validatePhraseInput(mnemonicRaw)
  if (err) throw new Error(err)
  const mnemonic = normalizeMnemonic(mnemonicRaw)

  const candidates = buildPhraseCandidates(mnemonic, passphrase)
  appendAppLog(
    'info',
    `[phrase-sweep] preview scanning ${candidates.length} derivation(s)`,
  )

  const hits: PhraseSourceHit[] = []
  let sameAsActive = false
  const activeIdentity = active.identityKey.toLowerCase()

  const inspectCandidate = async (candidate: PhraseCandidate): Promise<void> => {
    await yieldToUi()
    if (candidate.identityKey.toLowerCase() === activeIdentity) {
      sameAsActive = true
      return
    }
    let scan: LegacyScanResult
    try {
      scan = await scanAddressAny(candidate.address, active.chain)
    } catch (e) {
      appendAppLog(
        'warn',
        `[phrase-sweep] scan failed ${candidate.scheme} ${candidate.address}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
      return
    }
    const funding = scan.utxos.filter((u) => chooseLegacySweepPath(u).path === 'sweep')
    const fundingSats = funding.reduce((s, u) => s + u.satoshis, 0)
    // An ordinal tip is still an address UTXO. Empty Centi gap leaves therefore
    // need no GorillaPool request at all; only ask the ordinal index which
    // one-sat outputs are items when the chain scan found at least one candidate.
    const items = scan.utxos.some((utxo) => utxo.satoshis === 1)
      ? await countOrdinalsAtLeast(
          candidate.address,
          active.chain,
          PREVIEW_ITEM_CAP,
        )
      : { count: 0, capped: false }
    appendAppLog(
      'info',
      `[phrase-sweep] ${candidate.scheme} (${candidate.path}) ${candidate.address}: ` +
        `funding=${fundingSats}sats/${funding.length} items>=${items.count}${
          items.capped ? '+' : ''
        }`,
    )
    if (funding.length === 0 && items.count === 0) return
    hits.push({
      candidate,
      scan,
      fundingSats,
      fundingCount: funding.length,
      itemCountAtLeast: items.count,
      itemCountCapped: items.capped,
    })
  }

  for (const candidate of candidates) {
    await inspectCandidate(candidate)
  }

  // Always inspect Centi too. A phrase may have been used by more than one
  // wallet, so finding a Yours/HandCash hit is not evidence that its Centi
  // branches are empty. Recovery favours completeness over a shorter preview.
  const centi = buildCentiPhraseCandidates(mnemonic, passphrase)
  candidates.push(...centi)
  appendAppLog(
    'info',
    `[phrase-sweep] scanning ${centi.length} Centi address(es)`,
  )
  for (const candidate of centi) {
    await inspectCandidate(candidate)
  }

  const scoreHit = (h: PhraseSourceHit) =>
    h.fundingSats * 1_000 + h.itemCountAtLeast
  hits.sort((a, b) => scoreHit(b) - scoreHit(a))

  const primary =
    hits[0]?.candidate ??
    candidates.find((c) => c.scheme === 'brc-75') ??
    candidates[0]!

  const fundingSats = hits.reduce((s, h) => s + h.fundingSats, 0)
  const fundingCount = hits.reduce((s, h) => s + h.fundingCount, 0)
  const itemCountAtLeast = hits.reduce((s, h) => s + h.itemCountAtLeast, 0)
  const itemCountCapped = hits.some((h) => h.itemCountCapped)

  appendAppLog(
    'info',
    `[phrase-sweep] preview hits=${hits.length} funding=${fundingSats}sats items>=${itemCountAtLeast}`,
  )

  return {
    hits,
    primary,
    fundingSats,
    fundingCount,
    itemCountAtLeast,
    itemCountCapped,
    sameAsActive: sameAsActive && hits.length === 0,
  }
}

/**
 * Write Activity for coins an earlier run already swept.
 *
 * Sweeps that landed before this path recorded receipts left the coins in the
 * balance with nothing in Activity, and no later pass would ever write them:
 * Refresh only ingests this wallet's own addresses, not an imported phrase.
 * The durable sweep mark is the only remaining evidence, so it is what we read.
 * `recordFundingReceipts` de-dupes on the receive txid, so this is idempotent.
 */
function backfillSweptFundingActivity(
  funding: LegacyUtxo[],
  importedOutpoints: string[],
): void {
  const imported = new Set(importedOutpoints.map((op) => op.trim().toLowerCase()))
  const receipts = funding.flatMap((utxo) => {
    const op = utxo.outpoint.trim().toLowerCase()
    if (imported.has(op)) return []
    // No recorded sweep txid means no proof the coins ever moved here.
    const sweepTxid = legacySweepRecord(op)?.txid
    if (!sweepTxid || !(utxo.satoshis > 0)) return []
    return [{ outpoint: op, satoshis: utxo.satoshis, receiveTxid: utxo.txid, sweepTxid }]
  })
  if (receipts.length > 0) recordFundingReceipts(receipts)
}

/** One address of a phrase and the coins scanned on it. */
export type PhraseFundingSource = { candidate: PhraseCandidate; utxos: LegacyUtxo[] }

/**
 * Sweep funding UTXOs from one or more phrase addresses into the unlocked
 * wallet. Each coin is signed by the key of the address holding it, so coins
 * at many addresses share transactions instead of costing one per address.
 */
export async function sweepPhraseFunding(args: {
  sources: readonly PhraseFundingSource[]
}): Promise<PhraseFundingSweepResult> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock this wallet first')
  assertOnlineForPayment()
  if (args.sources.some((s) => s.candidate.identityKey.toLowerCase() === active.identityKey.toLowerCase())) {
    throw new Error('That phrase is already this wallet — use Refresh instead')
  }

  const spendKeys = new Map<string, string>()
  const funding: LegacyUtxo[] = []
  for (const { candidate, utxos } of args.sources) {
    for (const utxo of utxos) {
      if (chooseLegacySweepPath(utxo).path !== 'sweep') continue
      const op = utxo.outpoint.trim().toLowerCase()
      if (spendKeys.has(op)) continue
      spendKeys.set(op, candidate.rootKeyHex)
      funding.push(utxo)
    }
  }
  if (funding.length === 0) {
    return { imported: 0, failed: 0, fundingSatsMoved: 0, errors: [], alreadySwept: 0 }
  }

  return runExclusiveSpend(async () => {
    let result = await importLegacyUtxos(funding, active, { spendKeys })

    // Everything marked imported, yet the phrase address still lists the coins:
    // the stuck-sweep signature. Same heal as the own-address ingest — retry only
    // where the recorded sweep tx is provably absent from the chain.
    if (result.imported === 0 && result.skippedKnown > 0) {
      const retryable = await retryableStuckSweeps(funding, active.chain)
      if (retryable.length > 0) {
        forgetLegacyImported(retryable)
        appendAppLog(
          'warn',
          `[phrase-sweep] ${retryable.length} funding out(s) marked imported with no sweep tx on chain — retrying`,
        )
        result = await importLegacyUtxos(funding, active, { spendKeys })
      }
    }

    // Without this the coins land in the balance with no Activity row, which
    // reads as a sweep that silently did nothing.
    recordFundingReceipts(result.importedReceipts)
    backfillSweptFundingActivity(funding, result.importedOutpoints)

    const moved = result.importedReceipts.reduce((s, r) => s + r.satoshis, 0)
    appendAppLog(
      'info',
      `[phrase-sweep] swept ${args.sources[0]!.candidate.scheme} addresses=${args.sources.length}: ` +
        `imported=${result.imported} failed=${result.failed} ` +
        `alreadySwept=${result.skippedKnown} moved=${moved}sats`,
    )
    // createAction sweeps never went through brc100Handler, so archive the same
    // way other money-moving paths do once coins actually landed here.
    if (result.imported > 0 || moved > 0) {
      scheduleHistoryBackupPush('phrase-sweep')
    }
    return {
      imported: result.imported,
      failed: result.failed,
      fundingSatsMoved: moved,
      errors: result.errors.slice(0, 8),
      alreadySwept: result.skippedKnown,
    }
  })
}

export type SingleItemMigrate =
  | { kind: 'moved'; txid: string }
  | { kind: 'skipped'; reason: OrdinalMigrateSkipReason; message: string }
  | { kind: 'unreadable'; message: string }
  | { kind: 'funds'; message: string }
  /** Not tried: the wallet's fee coin was spent elsewhere and is being cleared. */
  | { kind: 'deferred'; message: string }
  | { kind: 'failed'; message: string }

/** A tip the user chose, the key that unlocks it, and the index's names for it. */
export type ChosenPhraseItem = {
  /** `txid_vout` or `txid.vout`. */
  outpoint: string
  /** Private key (hex) of the address holding the tip. */
  keyHex: string
  origin?: string
  name?: string
  /** The index's view of the origin when chosen; display only, the move re-decides the tip. */
  indexed?: {
    app: string | null
    collectionId: string | null
    /** Outpoint holding the art, when it is not the origin. */
    content: string | null
    mimeType: string | null
    signer: string | null
  }
}

export type ChosenItemsMigrate = {
  /** Every chosen tip's answer, keyed by the outpoint as given. */
  results: Map<string, SingleItemMigrate>
  stopped: ItemMigrateStop | null
  transactions: number
}

/**
 * Move chosen tips on the P2PKH item-migrate path. Each tip names the key that
 * unlocks it, so tips held at different addresses of one source — a HandCash
 * export keeps nearly every item at its own — still share transactions,
 * `MAX_ITEMS_PER_MIGRATE_TX` at a time. `itemMigrateRunMachine` decides when a
 * rejected bundle is halved and when the run stops.
 */
export async function migrateChosenPhraseItems(args: {
  items: readonly ChosenPhraseItem[]
  /** Wallet job id: every Activity row of the run folds into one record. */
  activityGroup?: string | null
  /** Runs once this run's source transactions are read — the moment to start reading the next run's. */
  onSourcesRead?: () => void
  /** Runs as each transaction is signed, with how many tips it moved. */
  onProgress?: (moved: number) => void
  /** True while a bundle queues for the wallet; false once it starts. */
  onWaiting?: (waiting: boolean) => void
}): Promise<ChosenItemsMigrate> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock this wallet first')
  assertOnlineForPayment()
  const results = new Map<string, SingleItemMigrate>()
  if (args.items.length === 0) return { results, stopped: null, transactions: 0 }
  const startedAt = Date.now()
  const destLock = new P2PKH().lock(active.address).toHex()
  const spenders = new Map<string, ItemSpender & { address: string }>()
  const spenderOf = (keyHex: string) => {
    const known = spenders.get(keyHex)
    if (known) return known
    const key = PrivateKey.fromHex(keyHex)
    if (key.toPublicKey().toString().toLowerCase() === active.identityKey.toLowerCase()) {
      throw new Error('That phrase is already this wallet')
    }
    const address = key.toAddress()
    const spender = { key, address, lockHex: new P2PKH().lock(address).toHex() }
    spenders.set(keyHex, spender)
    return spender
  }

  const givenOf = new Map<string, string>()
  const rows = args.items.map((item) => {
    const outpoint = item.outpoint.toLowerCase().replace(/_(\d+)$/, '.$1')
    givenOf.set(outpoint, item.outpoint)
    return {
      outpoint,
      spender: spenderOf(item.keyHex),
      ...(item.origin ? { origin: item.origin } : {}),
      ...(item.name ? { name: item.name } : {}),
    }
  })
  const built = await buildLegacyInputBeef(
    active.services,
    rows.map((row) => row.outpoint),
    { concurrency: 8 },
  )
  args.onSourcesRead?.()
  const sourceBeef = built.beef.length > 0 ? Beef.fromBinary(built.beef) : null

  const pending: PendingItemMigrate[] = []
  let skipped = 0
  let unreadable = 0
  for (const row of rows) {
    const given = givenOf.get(row.outpoint)!
    const plan = planOrdinalMigrate(sourceBeef, row, row.spender)
    if (plan.kind === 'skip') {
      skipped += 1
      results.set(given, { kind: 'skipped', reason: plan.reason, message: describeOrdinalMigrateSkip(plan.reason) })
    } else if (plan.kind === 'unreadable') {
      unreadable += 1
      results.set(given, {
        kind: 'unreadable',
        message: built.failures.find((f) => f.outpoint === row.outpoint)?.reason ?? 'source output could not be read',
      })
    } else {
      pending.push(plan.item)
    }
  }

  const nameOf = new Map(rows.map((row) => [row.outpoint, row.name ?? null]))
  const indexedOf = new Map(
    args.items.map((item) => [item.outpoint.toLowerCase().replace(/_(\d+)$/, '.$1'), item.indexed]),
  )
  const outcome = await migrateOrdinalUnit({
    active,
    destLockHex: destLock,
    inputBeef: built.beef,
    sources: sourceBeef,
    items: pending,
    itemsPerTx: MAX_ITEMS_PER_MIGRATE_TX,
    ...(args.onWaiting ? { onWaiting: args.onWaiting } : {}),
    onMoved: (receipts) => {
      const named = receipts.map((item) => ({ ...item, name: nameOf.get(item.outpoint) ?? null }))
      recordMigratedItemActivity(named, active.chain, { groupId: args.activityGroup })
      // Collect cannot re-read the basket while the import holds the wallet;
      // these tips are known exactly, so they show as each transaction lands.
      const tips = named.map((item) => ({
        outpoint: `${item.sweepTxid}.${item.sweepVout}`,
        chain: active.chain,
        origin: item.origin.replace(/\.(\d+)$/, '_$1'),
        name: item.name,
        ...indexedOf.get(item.outpoint),
        identityKey: active.identityKey,
      }))
      void import('./collectables')
        .then(({ noteIngestedItems }) => noteIngestedItems(tips))
        .catch((err) => console.warn('[phrase-sweep] collectables paint skipped', err))
      args.onProgress?.(receipts.length)
    },
  })
  for (const receipt of outcome.moved) {
    results.set(givenOf.get(receipt.outpoint)!, { kind: 'moved', txid: receipt.sweepTxid })
  }
  for (const failure of outcome.failures) {
    results.set(givenOf.get(failure.outpoint)!, { kind: 'failed', message: failure.reason })
  }
  const unmoved: SingleItemMigrate =
    outcome.stopped == null || outcome.stopped === 'funds'
      ? { kind: 'funds', message: ITEM_MIGRATE_STOP_MESSAGES.funds }
      : { kind: 'deferred', message: ITEM_MIGRATE_STOP_MESSAGES[outcome.stopped] }
  for (const item of pending.slice(outcome.resolved)) {
    results.set(givenOf.get(item.outpoint)!, unmoved)
  }

  const transactions = new Set(outcome.moved.map((m) => m.sweepTxid)).size
  if (outcome.moved.length > 0) scheduleHistoryBackupPush('phrase-sweep')
  appendAppLog(
    outcome.failures.length > 0 || unreadable > 0 || outcome.stopped ? 'warn' : 'info',
    `[phrase-sweep] chosen done ${Date.now() - startedAt}ms items=${rows.length} keys=${spenders.size} moved=${outcome.moved.length}` +
      ` tx=${transactions} skipped=${skipped} unreadable=${unreadable} failed=${outcome.failures.length}` +
      (outcome.stopped ? ` stopped=${outcome.stopped}` : '') +
      (outcome.lastError ? ` lastError=${outcome.lastError.slice(0, 160)}` : ''),
  )
  return { results, stopped: outcome.stopped, transactions }
}

/** A source key and the P2PKH lock its tips must carry. */
type ItemSpender = { key: PrivateKey; lockHex: string }

/** One tip that passed eligibility, with everything signing needs. */
type PendingItemMigrate = {
  outpoint: string
  txid: string
  vout: number
  origin: string
  customInstructions: string
  /** Real value of the source output — the sighash amount must match exactly. */
  satoshis: number
  /** Real locking script of the tip — the sighash scriptCode must match it. */
  sourceLock: LockingScript
  spendKey: PrivateKey
}

/** Ceiling on one wait for the spend region (not chain ingest — a spend runs beside it). */
const WALLET_BUSY_WAIT_MS = 120_000
/** A bundle queued this long says so instead of looking stuck. */
const WAITING_SHOWN_AFTER_MS = 3_000
/** Visible time an abandoned migrate gets to report its own outcome. */
const ABANDONED_SETTLE_MS = 300_000

type AbandonedMigrate =
  | { kind: 'posted'; posted: ForeignInputPosted }
  | { kind: 'failed'; error: unknown }
  | { kind: 'unknown' }

function isPosted(value: unknown): value is ForeignInputPosted {
  const posted = value as Partial<ForeignInputPosted> | null
  return (
    typeof posted?.txid === 'string' &&
    /^[0-9a-f]{64}$/.test(posted.txid) &&
    (posted.propagation === 'accepted' || posted.propagation === 'propagating')
  )
}

/**
 * The spend region gave up on a migrate, but the work itself cannot be
 * cancelled: it may still sign every tip of the bundle. Wait for what it
 * actually did before deciding anything about those tips.
 */
async function settleAbandonedMigrate(late: Promise<unknown>): Promise<AbandonedMigrate> {
  let cancel: (() => void) | undefined
  const expired = new Promise<AbandonedMigrate>((resolve) => {
    cancel = setVisibleTimeout(() => resolve({ kind: 'unknown' }), ABANDONED_SETTLE_MS)
  })
  try {
    return await Promise.race([
      late.then(
        (value): AbandonedMigrate => (isPosted(value) ? { kind: 'posted', posted: value } : { kind: 'unknown' }),
        (error: unknown): AbandonedMigrate => ({ kind: 'failed', error }),
      ),
      expired,
    ])
  } finally {
    cancel?.()
  }
}

type ItemMigratePlan =
  | { kind: 'move'; item: PendingItemMigrate }
  | { kind: 'skip'; reason: OrdinalMigrateSkipReason }
  | { kind: 'unreadable' }

/**
 * Decide one indexer row from its source transaction, not from the listing:
 * the listing returns the address's cash outputs too, and signing those as
 * 1-sat tips fails closed.
 */
function planOrdinalMigrate(
  sourceBeef: Beef | null,
  row: { outpoint: string; origin?: string; name?: string },
  spender: ItemSpender,
): ItemMigratePlan {
  const [txidPart, voutPart] = row.outpoint.split('.')
  const txid = (txidPart ?? '').toLowerCase()
  const vout = Number(voutPart)
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0) {
    return { kind: 'unreadable' }
  }
  const sourceTx = sourceBeef?.findTxid(txid)?.tx ?? null
  const sourceOut = sourceTx?.outputs[vout] ?? null
  if (!sourceTx || !sourceOut) return { kind: 'unreadable' }

  const sourceLock = sourceOut.lockingScript ?? null
  const eligibility = chooseOrdinalMigratePath(
    {
      satoshis: sourceOut.satoshis ?? null,
      lockingScriptHex: sourceLock?.toHex() ?? null,
      runJig: runJigVouts(sourceTx).has(vout),
    },
    spender.lockHex,
  )
  if (eligibility.path === 'skip') return { kind: 'skip', reason: eligibility.reason }

  const origin = (row.origin ?? row.outpoint).replace(/_(\d+)$/, '.$1')
  return {
    kind: 'move',
    item: {
      outpoint: row.outpoint,
      txid,
      vout,
      origin,
      customInstructions: buildInternalizeCustomInstructions({
        origin,
        name: (row.name ?? 'Collectable').slice(0, 40),
      }),
      satoshis: eligibility.satoshis,
      sourceLock: sourceLock!,
      spendKey: spender.key,
    },
  }
}

type UnitOutcome = {
  moved: MigratedItemReceipt[]
  /** Tips refused alone, after any bundle they rode was split down to them. */
  failures: Array<{ outpoint: string; reason: string }>
  /** Leading tips this run settled, moved or failed; the rest were not tried. */
  resolved: number
  stopped: ItemMigrateStop | null
  lastError: string | null
}

type UnitArgs = {
  active: ActiveWallet
  destLockHex: string
  /** Every source of the run; a bundle is handed only the part it spends. */
  inputBeef: BEEF
  sources: Beef | null
  items: PendingItemMigrate[]
  itemsPerTx: number
  /**
   * Each transaction's receipts, the moment it is signed. Its Activity rows
   * must land before the ledger's next read of the wallet's table, or the
   * unannotated migrate shows as a row of its own.
   */
  onMoved: (moved: MigratedItemReceipt[]) => void
  /** True while a bundle queues for the wallet (unlock, another send); false once it starts. */
  onWaiting?: (waiting: boolean) => void
}

/**
 * Executor for `itemMigrateRunMachine`: sends the bundle the chart asks for
 * and reports one classified outcome. Every attempt is the same P2PKH
 * item-migrate path; the chart alone decides whether another one follows.
 */
async function migrateOrdinalUnit(args: UnitArgs): Promise<UnitOutcome> {
  const out: UnitOutcome = { moved: [], failures: [], resolved: 0, stopped: null, lastError: null }
  let pending = args.items.slice()
  const postBytes = new Map<string, number>()
  const postBytesOf = (item: PendingItemMigrate): number => {
    let bytes = postBytes.get(item.outpoint)
    if (bytes == null) {
      bytes = migrateTipPostBytes(item.sourceLock.toBinary().length)
      postBytes.set(item.outpoint, bytes)
    }
    return bytes
  }

  const chart = createActor(itemMigrateRunMachine).start()
  chart.send({ type: 'START', items: pending.length, perTx: args.itemsPerTx })
  try {
    for (;;) {
      const snapshot = chart.getSnapshot()
      if (snapshot.matches('waitingForWallet')) {
        const { describeWalletCoordinator, waitForSpendRegionFree } = await import('./walletCoordinator')
        const waitStarted = Date.now()
        const free = await waitForSpendRegionFree(WALLET_BUSY_WAIT_MS)
        appendAppLog(
          'info',
          `[phrase-sweep] busy wait done ${Date.now() - waitStarted}ms idle=${free}` +
            (free ? '' : ` held=${describeWalletCoordinator().summary.slice(0, 160)}`),
        )
        chart.send({ type: 'WAITED' })
        continue
      }
      if (!snapshot.matches('moving')) break
      if (out.moved.length > 0 || out.failures.length > 0) await yieldToUi()
      const unit = chooseItemMigrateUnit(pending, itemsWithinPostBudget(pending, snapshot.context.perTx, postBytesOf))
      if (unit.kind === 'refuse') {
        console.warn('[phrase-sweep] chart expected a bundle but no tip is pending')
        break
      }
      const group = unit.kind === 'bundle' ? unit.items : [unit.item]
      const landed = (posted: ForeignInputPosted) => {
        // Outputs keep their order (`randomizeOutputs: false`), so item i is output i.
        const receipts = group.map((item, vout) => ({
          outpoint: item.outpoint,
          origin: item.origin,
          sweepTxid: posted.txid,
          sweepVout: vout,
        }))
        out.moved.push(...receipts)
        args.onMoved(receipts)
        out.resolved += group.length
        pending = pending.slice(group.length)
        chart.send({ type: 'SENT', items: group.length, propagation: posted.propagation })
      }

      let fault: ItemMigrateFault
      try {
        landed(await sendItemBundle(args, group))
        continue
      } catch (caught) {
        fault = classifyItemMigrateFault(caught, group)
      }
      if (fault.kind === 'abandoned') {
        const settledAt = Date.now()
        const settled = await settleAbandonedMigrate(fault.late)
        appendAppLog(
          settled.kind === 'posted' ? 'info' : 'warn',
          `[phrase-sweep] abandoned migrate of ${group.length} settled ${settled.kind}` +
            (settled.kind === 'posted' ? ` ${settled.posted.txid.slice(0, 12)}` : '') +
            ` after ${Date.now() - settledAt}ms`,
        )
        if (settled.kind === 'posted') {
          landed(settled.posted)
          continue
        }
        if (settled.kind === 'failed') fault = classifyItemMigrateFault(settled.error, group)
      }
      if (fault.kind === 'busy') {
        appendAppLog('info', `[phrase-sweep] wallet busy before sending ${group.length} held=${fault.held.slice(0, 160)}`)
      } else if (fault.kind === 'rejected' && group.length > 1) {
        appendAppLog('info', `[phrase-sweep] bundleRejected: ${group.length} tips — halving (${fault.message.slice(0, 160)})`)
      } else if (fault.kind === 'rejected') {
        out.failures.push({ outpoint: group[0]!.outpoint, reason: fault.message })
        out.resolved += 1
        out.lastError = fault.message
        pending = pending.slice(1)
        console.warn('[phrase-sweep] item migrate failed', group[0]!.outpoint, fault.message)
      } else {
        out.lastError = fault.message
        appendAppLog('warn', `[phrase-sweep] ${fault.kind} before sending ${group.length}: ${fault.message.slice(0, 160)}`)
      }
      chart.send({ type: 'FAULT', fault: fault.kind, items: group.length, message: fault.message })
    }
  } finally {
    const settled = chart.getSnapshot().context
    out.stopped = settled.stopped
    if (out.stopped) {
      out.lastError ??= ITEM_MIGRATE_STOP_MESSAGES[out.stopped]
      appendAppLog('warn', `[phrase-sweep] stopped: ${out.stopped} moved=${settled.moved} failed=${settled.failed} queued=${settled.queued}`)
    }
    chart.stop()
  }
  return out
}

/** One bundle through the spend region, after any payment already waiting. */
async function sendItemBundle(args: UnitArgs, group: PendingItemMigrate[]): Promise<ForeignInputPosted> {
  // A payment waits for at most the bundle in flight, never the whole import.
  const yieldedMs = await yieldToForegroundSpends(undefined, {
    onWaiting: (waitedMs, holders) =>
      appendAppLog(
        'info',
        `[phrase-sweep] waiting for payments ${Math.round(waitedMs / 1000)}s — ${holders.join(', ').slice(0, 160)}`,
      ),
  })
  if (yieldedMs >= 250) appendAppLog('info', `[phrase-sweep] yielded to payments done ${yieldedMs}ms`)
  const inputBeef = args.sources
    ? migrateInputBeef(args.sources, new Set(group.map((item) => item.txid)), args.inputBeef)
    : args.inputBeef
  let waitingShown = false
  const waitingTimer = setTimeout(() => {
    waitingShown = true
    args.onWaiting?.(true)
  }, WAITING_SHOWN_AFTER_MS)
  const regionTaken = () => {
    clearTimeout(waitingTimer)
    if (waitingShown) args.onWaiting?.(false)
    waitingShown = false
  }
  return runExclusiveSpend(
    () => buildAndPostItemMigrate({ active: args.active, destLockHex: args.destLockHex, inputBeef, items: group }),
    regionTaken,
    { lane: 'background' },
  ).finally(regionTaken)
}

/** Chain ingest for the end of a migrate run. */
export async function refreshAfterPhraseItemMigrate(): Promise<void> {
  try {
    await refreshFromChain({ forceReview: true, announceReceive: true })
  } catch (err) {
    console.warn('[phrase-sweep] post-migrate refresh failed', err)
  }
}

/** Build, sign and hand off one transaction carrying `items` tips. */
async function buildAndPostItemMigrate(args: {
  active: ActiveWallet
  destLockHex: string
  inputBeef: BEEF
  items: PendingItemMigrate[]
}): Promise<ForeignInputPosted> {
  const { destLockHex, items } = args
  const first = items[0]!
  return postForeignInputAction({
    active: args.active,
    inputBeef: args.inputBeef,
    inputs: items.map((item) => ({ ...item, description: 'migrate ordinal from phrase' })),
    outputs: items.map((item) => ({
      lockingScript: destLockHex,
      satoshis: 1,
      outputDescription: 'Migrated collectable',
      basket: '1sat',
      tags: ['ordinal', 'phrase-migrate', `origin:${item.origin.replace(/_(\d+)$/, '.$1')}`],
      customInstructions: item.customInstructions,
    })),
    labels: ['1sat', 'phrase-migrate'],
    description: itemMigrateTxDescription(items.length, first.outpoint),
  })
}
