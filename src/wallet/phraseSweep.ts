/**
 * Import another BIP39 phrase into the unlocked wallet.
 *
 * 1. Derive BRC-75 + legacy-HD roots; pick the address that holds UTXOs.
 * 2. Sweep funding (satoshis ≥ sweep floor) into this wallet — signed with the
 *    foreign key, change credited to the active identity.
 * 3. Optionally migrate 1-sat ordinals in small batches (resumable). Huge
 *    collections (e.g. 100k+) take a long time — progress is explicit.
 */
import { Beef, P2PKH, PrivateKey, type BEEF, type LockingScript } from '@bsv/sdk'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  keyFromMnemonicHdPath,
  rootKeyFromMnemonicBrc75,
  rootKeyFromMnemonicLegacyHd,
  type Chain,
} from './vault'
import { appendAppLog } from './appLog'
import { getActiveWallet, type ActiveWallet } from './session'
import {
  importLegacyUtxos,
  scanAddressViaBitails,
  scanAddressViaWhatsOnChain,
  type LegacyScanResult,
  type LegacyUtxo,
} from './legacyScan'
import { chooseLegacySweepPath } from './legacySweepPath'
import { buildLegacyInputBeef, withVisibleOnChainBeef } from './legacyBeef'
import { forgetLegacyImported, legacySweepRecord } from './legacyImportGuard'
import { retryableStuckSweeps } from './legacyStuckSweep'
import {
  recordFundingReceipts,
  recordMigratedItemActivity,
  type MigratedItemReceipt,
} from './legacyReceiptActivity'
import {
  chooseOrdinalMigratePath,
  describeOrdinalMigrateSkip,
  type OrdinalMigrateSkipReason,
} from './ordinalMigratePath'
import { yieldToUi } from './yieldToUi'
import { runExclusiveSpend } from './spendGuard'
import { assertOnlineForPayment } from './paymentPolicy'
import { buildInternalizeCustomInstructions } from './oneSatProvenance'
import { summarizePostBeef } from './postBeefResult'
import { refreshFromChain } from './chainIngest'

const ITEM_CURSOR_KEY = 'handcash.brc100.phraseSweepItemCursor.v1'
const GP_PAGE = 50
/** Soft preview cap — full count continues during migrate. */
const PREVIEW_ITEM_CAP = 5_000

export type PhraseScheme =
  | 'brc-75'
  | 'legacy-hd'
  | 'yours-wallet'
  | 'yours-ord'
  | 'yours-relayx-ord'
  | 'yours-sweep'
  | 'yours-identity'
  | 'twetch'

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

export type PhraseItemMigrateProgress = {
  moved: number
  failed: number
  /**
   * Outputs the indexer listed for the address that are not migratable tips —
   * cash outputs, and tips this phrase key cannot unlock.
   */
  skipped: number
  scanned: number
  done: boolean
  lastError: string | null
}

type ItemCursor = {
  sourceAddress: string
  destIdentityKey: string
  offset: number
  moved: number
  failed: number
  /** Absent on cursors written before skips were tracked. */
  skipped?: number
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

async function scanAddressAny(
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
async function countOrdinalsAtLeast(
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

  for (const candidate of candidates) {
    await yieldToUi()
    if (candidate.identityKey.toLowerCase() === activeIdentity) {
      sameAsActive = true
      continue
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
      continue
    }
    const funding = scan.utxos.filter((u) => chooseLegacySweepPath(u).path === 'sweep')
    const fundingSats = funding.reduce((s, u) => s + u.satoshis, 0)
    const items = await countOrdinalsAtLeast(
      candidate.address,
      active.chain,
      PREVIEW_ITEM_CAP,
    )
    appendAppLog(
      'info',
      `[phrase-sweep] ${candidate.scheme} (${candidate.path}) ${candidate.address}: ` +
        `funding=${fundingSats}sats/${funding.length} items>=${items.count}${
          items.capped ? '+' : ''
        }`,
    )
    if (funding.length === 0 && items.count === 0) continue
    hits.push({
      candidate,
      scan,
      fundingSats,
      fundingCount: funding.length,
      itemCountAtLeast: items.count,
      itemCountCapped: items.capped,
    })
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

/**
 * Sweep funding UTXOs from the phrase into the unlocked wallet.
 */
export async function sweepPhraseFunding(args: {
  mnemonic: string
  passphrase?: string
  candidate: PhraseCandidate
  utxos: LegacyUtxo[]
}): Promise<PhraseFundingSweepResult> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock this wallet first')
  assertOnlineForPayment()
  if (args.candidate.identityKey.toLowerCase() === active.identityKey.toLowerCase()) {
    throw new Error('That phrase is already this wallet — use Refresh instead')
  }

  const funding = args.utxos.filter((u) => chooseLegacySweepPath(u).path === 'sweep')
  if (funding.length === 0) {
    return { imported: 0, failed: 0, fundingSatsMoved: 0, errors: [], alreadySwept: 0 }
  }

  return runExclusiveSpend(async () => {
    const spendKeyHex = args.candidate.rootKeyHex
    let result = await importLegacyUtxos(funding, active, { spendKeyHex })

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
        result = await importLegacyUtxos(funding, active, { spendKeyHex })
      }
    }

    // Without this the coins land in the balance with no Activity row, which
    // reads as a sweep that silently did nothing.
    recordFundingReceipts(result.importedReceipts)
    backfillSweptFundingActivity(funding, result.importedOutpoints)

    const moved = result.importedReceipts.reduce((s, r) => s + r.satoshis, 0)
    appendAppLog(
      'info',
      `[phrase-sweep] swept ${args.candidate.scheme} (${args.candidate.path}): ` +
        `imported=${result.imported} failed=${result.failed} ` +
        `alreadySwept=${result.skippedKnown} moved=${moved}sats`,
    )
    return {
      imported: result.imported,
      failed: result.failed,
      fundingSatsMoved: moved,
      errors: result.errors.slice(0, 8),
      alreadySwept: result.skippedKnown,
    }
  })
}

function readItemCursor(): ItemCursor | null {
  try {
    const raw = durableGetItem(ITEM_CURSOR_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as ItemCursor
    if (!p?.sourceAddress || typeof p.offset !== 'number') return null
    return p
  } catch {
    return null
  }
}

function writeItemCursor(cursor: ItemCursor | null) {
  if (!cursor) {
    durableSetItem(ITEM_CURSOR_KEY, '')
    return
  }
  durableSetItem(ITEM_CURSOR_KEY, JSON.stringify(cursor))
}

export function clearPhraseItemMigrateCursor(): void {
  writeItemCursor(null)
}

export function peekPhraseItemMigrateCursor(): ItemCursor | null {
  return readItemCursor()
}

function asBytes(tx: unknown): number[] {
  if (Array.isArray(tx) && tx.every((n) => typeof n === 'number')) return tx as number[]
  if (tx instanceof Uint8Array) return Array.from(tx)
  return []
}

/**
 * Move one page of 1-sat ordinals from the phrase address onto this wallet.
 * Destination change pays fees. Resumes via durable cursor.
 */
export async function migratePhraseItemsBatch(args: {
  candidate: PhraseCandidate
  batchSize?: number
}): Promise<PhraseItemMigrateProgress> {
  const active = getActiveWallet()
  if (!active) throw new Error('Unlock this wallet first')
  assertOnlineForPayment()
  if (args.candidate.identityKey.toLowerCase() === active.identityKey.toLowerCase()) {
    throw new Error('That phrase is already this wallet')
  }

  const batchSize = Math.max(1, Math.min(args.batchSize ?? 5, 20))
  let cursor = readItemCursor()
  if (
    !cursor ||
    cursor.sourceAddress !== args.candidate.address ||
    cursor.destIdentityKey.toLowerCase() !== active.identityKey.toLowerCase()
  ) {
    cursor = {
      sourceAddress: args.candidate.address,
      destIdentityKey: active.identityKey,
      offset: 0,
      moved: 0,
      failed: 0,
      skipped: 0,
    }
  }

  const page = await fetchOrdinalPage(
    args.candidate.address,
    active.chain,
    cursor.offset,
  )
  if (page.rawCount === 0) {
    writeItemCursor(null)
    return {
      moved: cursor.moved,
      failed: cursor.failed,
      skipped: cursor.skipped ?? 0,
      scanned: cursor.offset,
      done: true,
      lastError: null,
    }
  }

  // Consume raw indexer rows in order so the cursor stays exact; eligibility is
  // decided per row from the source transaction inside migrateOneOrdinal.
  const slice = page.rows.slice(0, batchSize)
  let moved = 0
  let failed = 0
  let skipped = 0
  let lastError: string | null = null
  const spendKey = PrivateKey.fromHex(args.candidate.rootKeyHex)
  const destLock = new P2PKH().lock(active.address).toHex()
  const movedItems: MigratedItemReceipt[] = []

  for (const item of slice) {
    await yieldToUi()
    try {
      const outcome = await runExclusiveSpend(async () =>
        migrateOneOrdinal(active, spendKey, destLock, item),
      )
      if (outcome.kind === 'skipped') {
        skipped += 1
        continue
      }
      moved += 1
      movedItems.push({
        outpoint: item.outpoint,
        origin: item.origin,
        sweepTxid: outcome.txid,
      })
    } catch (err) {
      failed += 1
      lastError = err instanceof Error ? err.message : String(err)
      console.warn('[phrase-sweep] item migrate failed', item.outpoint, lastError)
    }
  }

  if (skipped > 0) {
    appendAppLog(
      'info',
      `[phrase-sweep] skipped ${skipped} non-collectable output(s) on ${args.candidate.address}`,
    )
  }

  const next: ItemCursor = {
    ...cursor,
    offset: cursor.offset + slice.length,
    moved: cursor.moved + moved,
    failed: cursor.failed + failed,
    skipped: (cursor.skipped ?? 0) + skipped,
  }
  const done = page.rawCount < GP_PAGE && slice.length >= page.rows.length
  if (done) writeItemCursor(null)
  else writeItemCursor(next)

  if (moved > 0) {
    recordMigratedItemActivity(movedItems, active.chain)
    try {
      await refreshFromChain({ forceReview: true, announceReceive: true })
    } catch (err) {
      console.warn('[phrase-sweep] post-migrate refresh failed', err)
    }
  }

  return {
    moved: next.moved,
    failed: next.failed,
    skipped: next.skipped ?? 0,
    scanned: next.offset,
    done,
    lastError,
  }
}

type MigrateOutcome =
  | { kind: 'moved'; txid: string }
  | { kind: 'skipped'; reason: OrdinalMigrateSkipReason }

async function migrateOneOrdinal(
  active: ActiveWallet,
  spendKey: PrivateKey,
  destLockHex: string,
  item: { outpoint: string; origin?: string; name?: string },
): Promise<MigrateOutcome> {
  const [txidPart, voutPart] = item.outpoint.split('.')
  const txid = (txidPart ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('Bad outpoint')
  const vout = Number(voutPart)

  const built = await buildLegacyInputBeef(active.services, [item.outpoint])
  if (built.ready.length === 0 || built.beef.length === 0) {
    throw new Error(built.failures[0]?.reason ?? 'Could not load tip BEEF')
  }

  // Decide from the source transaction, not the indexer listing: it returns the
  // address's cash outputs too, and signing those as 1-sat tips fails closed.
  const sourceOut = Beef.fromBinary(built.beef).findTxid(txid)?.tx?.outputs[vout]
  const sourceLock = sourceOut?.lockingScript ?? null
  const eligibility = chooseOrdinalMigratePath(
    {
      satoshis: sourceOut?.satoshis ?? null,
      lockingScriptHex: sourceLock?.toHex() ?? null,
    },
    new P2PKH().lock(spendKey.toAddress()).toHex(),
  )
  if (eligibility.path === 'skip') {
    appendAppLog(
      'info',
      `[phrase-sweep] skip ${item.outpoint}: ${describeOrdinalMigrateSkip(eligibility.reason)}`,
    )
    return { kind: 'skipped', reason: eligibility.reason }
  }

  const origin = (item.origin ?? item.outpoint).replace(/_(\d+)$/, '.$1')
  const customInstructions = buildInternalizeCustomInstructions({
    origin,
    name: (item.name ?? 'Collectable').slice(0, 40),
  })

  // A foreign tip is fetched body-only: no BUMP, no ancestry. Default BEEF
  // verification rejects that outright ("inputBEEF must be valid Beef when
  // factoring options.trustSelf"), which failed every item migrate. The funding
  // sweep already treats visible-on-chain as sufficient for a P2PKH tip; an
  // ordinal tip is the same claim, so it runs under the same relaxation.
  const sweepTxid = await withVisibleOnChainBeef(async () =>
    buildAndPostItemMigrate({
      active,
      spendKey,
      destLockHex,
      item,
      origin,
      customInstructions,
      txid,
      inputBeef: built.beef,
      satoshis: eligibility.satoshis,
      sourceLock: sourceLock!,
    }),
  )
  return { kind: 'moved', txid: sweepTxid }
}

async function buildAndPostItemMigrate(args: {
  active: ActiveWallet
  spendKey: PrivateKey
  destLockHex: string
  item: { outpoint: string }
  origin: string
  customInstructions: string
  txid: string
  inputBeef: BEEF
  /** Real value of the source output — the sighash amount must match exactly. */
  satoshis: number
  /** Real locking script of the tip — the sighash scriptCode must match it. */
  sourceLock: LockingScript
}): Promise<string> {
  const { active, destLockHex, item, origin, customInstructions } = args

  const car = await active.wallet.createAction({
    inputBEEF: args.inputBeef,
    inputs: [
      {
        outpoint: item.outpoint,
        unlockingScriptLength: 108,
        inputDescription: 'migrate ordinal from phrase',
      },
    ],
    outputs: [
      {
        lockingScript: destLockHex,
        satoshis: 1,
        outputDescription: 'Migrated collectable',
        basket: '1sat',
        tags: ['ordinal', 'phrase-migrate', `origin:${origin.replace(/_(\d+)$/, '.$1')}`],
        customInstructions,
      },
    ],
    labels: ['1sat', 'phrase-migrate'],
    description: `Migrate ordinal ${item.outpoint.slice(0, 18)}…`,
    options: {
      trustSelf: 'known',
      signAndProcess: false,
      randomizeOutputs: false,
    },
  })

  const reference = car.signableTransaction?.reference
  try {
    return await signAndPostItemMigrate(args, car)
  } catch (err) {
    // An unsigned action keeps its reserved inputs and still lists its `1sat`
    // output, so a failed migrate showed up in Collect as a real collectable —
    // complete with the provenance we attached — until background review failed
    // the transaction and took it away again. Nothing was ever on chain, so
    // there is no broadcast to race: releasing it here is the only correct end.
    if (reference) {
      try {
        await args.active.wallet.abortAction({ reference })
      } catch (abortErr) {
        appendAppLog(
          'warn',
          `[phrase-sweep] could not abort failed migrate ${args.item.outpoint}: ${
            abortErr instanceof Error ? abortErr.message : String(abortErr)
          }`,
        )
      }
    }
    throw err
  }
}

async function signAndPostItemMigrate(
  args: {
    active: ActiveWallet
    spendKey: PrivateKey
    item: { outpoint: string }
    txid: string
    inputBeef: BEEF
    satoshis: number
    sourceLock: LockingScript
  },
  car: Awaited<ReturnType<ActiveWallet['wallet']['createAction']>>,
): Promise<string> {
  const { active, spendKey, item, txid } = args
  let sweepTxid = (car.txid ?? '').toLowerCase()
  let sweepAtomic = asBytes(car.tx)
  if (car.signableTransaction) {
    const stBeef = Beef.fromBinary(asBytes(car.signableTransaction.tx))
    let unsignedTx
    let inputIndex = -1
    const sourceTxid = txid
    const vout = Number(item.outpoint.split('.')[1])
    for (const stbtx of stBeef.txs) {
      if (stbtx.tx == null) continue
      for (let i = 0; i < stbtx.tx.inputs.length; i++) {
        const inp = stbtx.tx.inputs[i]
        if (
          String(inp.sourceTXID).toLowerCase() === sourceTxid &&
          inp.sourceOutputIndex === vout
        ) {
          unsignedTx = stbtx.tx
          inputIndex = i
          break
        }
      }
      if (unsignedTx != null) break
    }
    if (unsignedTx == null || inputIndex < 0) {
      throw new Error('Could not find ordinal input to sign')
    }
    // Ordinal tips are P2PKH ‖ inscription ‖ Sigma, so the sighash scriptCode
    // must be the *whole* locking script. SetupClient.getUnlockP2PKH hashes a
    // bare P2PKH, which is why every inscribed tip failed CHECKSIG with "the
    // top stack element must be truthy" while plain-P2PKH funding swept fine.
    unsignedTx.inputs[inputIndex]!.unlockingScriptTemplate = new P2PKH().unlock(
      spendKey,
      'all',
      false,
      args.satoshis,
      args.sourceLock,
    )
    await unsignedTx.sign()
    const unlockingScript = unsignedTx.inputs[inputIndex]!.unlockingScript!.toHex()
    const sar = await active.wallet.signAction({
      reference: car.signableTransaction.reference,
      spends: { [inputIndex]: { unlockingScript } },
    })
    sweepTxid = (sar.txid ?? '').toLowerCase()
    sweepAtomic = asBytes(sar.tx)
  }
  if (!/^[0-9a-f]{64}$/.test(sweepTxid) || sweepAtomic.length === 0) {
    throw new Error('Migrate produced no broadcastable transaction')
  }

  const packed = new Beef()
  packed.mergeBeef(args.inputBeef)
  packed.mergeBeef(sweepAtomic)
  packed.atomicTxid = undefined
  const bin = packed.toBinaryAtomic(sweepTxid)
  if (!active.services?.postBeef) throw new Error('No broadcast service')
  const results = await active.services.postBeef(Beef.fromBinary(bin), [sweepTxid])
  const summary = summarizePostBeef(results as never)
  if (!summary.accepted) {
    throw new Error(`Broadcast rejected (${summary.detail})`)
  }
  return sweepTxid
}
