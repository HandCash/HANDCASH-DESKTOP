/**
 * Import another BIP39 phrase into the unlocked wallet.
 *
 * 1. Derive BRC-75 + legacy-HD roots; pick the address that holds UTXOs.
 * 2. Sweep funding (satoshis ≥ sweep floor) into this wallet — signed with the
 *    foreign key, change credited to the active identity.
 * 3. Optionally migrate 1-sat ordinals in small batches (resumable). Huge
 *    collections (e.g. 100k+) take a long time — progress is explicit.
 */
import { Beef, P2PKH, PrivateKey } from '@bsv/sdk'
import { durableGetItem, durableSetItem } from './durableStorage'
import {
  rootKeyFromMnemonicBrc75,
  rootKeyFromMnemonicLegacyHd,
  type Chain,
} from './vault'
import { getActiveWallet, type ActiveWallet } from './session'
import {
  importLegacyUtxos,
  scanAddressViaBitails,
  scanAddressViaWhatsOnChain,
  type LegacyScanResult,
  type LegacyUtxo,
} from './legacyScan'
import { chooseLegacySweepPath } from './legacySweepPath'
import { buildLegacyInputBeef } from './legacyBeef'
import { yieldToUi } from './yieldToUi'
import { runExclusiveSpend } from './spendGuard'
import { assertOnlineForPayment } from './paymentPolicy'
import { buildInternalizeCustomInstructions } from './oneSatProvenance'
import { SetupClient } from '@bsv/wallet-toolbox-client'
import { summarizePostBeef } from './postBeefResult'
import { refreshFromChain } from './chainIngest'

const ITEM_CURSOR_KEY = 'handcash.brc100.phraseSweepItemCursor.v1'
const GP_PAGE = 50
/** Soft preview cap — full count continues during migrate. */
const PREVIEW_ITEM_CAP = 5_000

export type PhraseScheme = 'brc-75' | 'legacy-hd'

export type PhraseCandidate = {
  scheme: PhraseScheme
  rootKeyHex: string
  identityKey: string
  address: string
}

export type PhraseSweepPreview = {
  candidate: PhraseCandidate
  /** Alternate derivation that also had UTXOs (rare). */
  alsoFound: PhraseCandidate[]
  fundingSats: number
  fundingCount: number
  itemCountAtLeast: number
  itemCountCapped: boolean
  sameAsActive: boolean
  scan: LegacyScanResult
}

export type PhraseFundingSweepResult = {
  imported: number
  failed: number
  fundingSatsMoved: number
  errors: string[]
}

export type PhraseItemMigrateProgress = {
  moved: number
  failed: number
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

function scoreScan(scan: LegacyScanResult): number {
  const funding = scan.utxos.filter((u) => chooseLegacySweepPath(u).path === 'sweep')
  const fundingSats = funding.reduce((s, u) => s + u.satoshis, 0)
  const ones = scan.utxos.filter((u) => u.satoshis === 1).length
  return fundingSats * 1_000 + ones + scan.utxos.length
}

async function countOrdinalsAtLeast(
  address: string,
  chain: Chain,
  cap: number,
): Promise<{ count: number; capped: boolean }> {
  let offset = 0
  let count = 0
  while (count < cap) {
    const url =
      `${gorillaBase(chain)}/api/txos/address/${encodeURIComponent(address)}/unspent` +
      `?limit=${GP_PAGE}&offset=${offset}`
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) break
    const rows = (await res.json()) as unknown
    if (!Array.isArray(rows) || rows.length === 0) {
      return { count, capped: false }
    }
    count += rows.length
    if (rows.length < GP_PAGE) return { count, capped: false }
    offset += rows.length
    await yieldToUi()
  }
  return { count, capped: true }
}

type OrdinalRow = { outpoint: string; origin: string }

async function fetchOrdinalPage(
  address: string,
  chain: Chain,
  offset: number,
): Promise<OrdinalRow[]> {
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
  const rows = (await res.json()) as Array<Record<string, unknown>>
  if (!Array.isArray(rows)) return []
  return rows.flatMap((r): OrdinalRow[] => {
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
    return [{ outpoint, origin }]
  })
}

/**
 * Preview which derivation holds coins/items. Does not spend.
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

  const candidates: PhraseCandidate[] = [
    (() => {
      const d = rootKeyFromMnemonicBrc75(mnemonic, passphrase)
      return {
        scheme: 'brc-75' as const,
        rootKeyHex: d.rootKeyHex,
        identityKey: d.identityKey,
        address: d.address,
      }
    })(),
    (() => {
      const d = rootKeyFromMnemonicLegacyHd(mnemonic, passphrase)
      return {
        scheme: 'legacy-hd' as const,
        rootKeyHex: d.rootKeyHex,
        identityKey: d.identityKey,
        address: d.address,
      }
    })(),
  ]

  // Deduplicate if both schemes collide.
  const unique = new Map<string, PhraseCandidate>()
  for (const c of candidates) unique.set(c.address, c)

  let best: { candidate: PhraseCandidate; scan: LegacyScanResult; score: number } | null =
    null
  const alsoFound: PhraseCandidate[] = []

  for (const c of unique.values()) {
    await yieldToUi()
    let scan: LegacyScanResult
    try {
      scan = await scanAddressAny(c.address, active.chain)
    } catch (e) {
      console.warn('[phrase-sweep] scan failed', c.scheme, e)
      continue
    }
    const s = scoreScan(scan)
    if (!best || s > best.score) {
      if (best && best.score > 0) alsoFound.push(best.candidate)
      best = { candidate: c, scan, score: s }
    } else if (s > 0) {
      alsoFound.push(c)
    }
  }

  if (!best) {
    // Prefer BRC-75 (Yours / HandCash default) even if empty — clearer error.
    const fallback = candidates[0]!
    const emptyScan: LegacyScanResult = {
      address: fallback.address,
      chain: active.chain,
      sats: 0,
      utxos: [],
      source: 'whatsonchain',
      error: 'No UTXOs found for this phrase',
    }
    best = { candidate: fallback, scan: emptyScan, score: 0 }
  }

  const funding = best.scan.utxos.filter((u) => chooseLegacySweepPath(u).path === 'sweep')
  const fundingSats = funding.reduce((s, u) => s + u.satoshis, 0)
  const items = await countOrdinalsAtLeast(
    best.candidate.address,
    active.chain,
    PREVIEW_ITEM_CAP,
  )

  return {
    candidate: best.candidate,
    alsoFound,
    fundingSats,
    fundingCount: funding.length,
    itemCountAtLeast: items.count,
    itemCountCapped: items.capped,
    sameAsActive:
      best.candidate.identityKey.toLowerCase() === active.identityKey.toLowerCase(),
    scan: best.scan,
  }
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
    return { imported: 0, failed: 0, fundingSatsMoved: 0, errors: [] }
  }

  return runExclusiveSpend(async () => {
    const result = await importLegacyUtxos(funding, active, {
      spendKeyHex: args.candidate.rootKeyHex,
    })
    const moved = result.importedReceipts.reduce((s, r) => s + r.satoshis, 0)
    return {
      imported: result.imported,
      failed: result.failed,
      fundingSatsMoved: moved,
      errors: result.errors.slice(0, 8),
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
    }
  }

  const page = await fetchOrdinalPage(
    args.candidate.address,
    active.chain,
    cursor.offset,
  )
  if (page.length === 0) {
    writeItemCursor(null)
    return {
      moved: cursor.moved,
      failed: cursor.failed,
      scanned: cursor.offset,
      done: true,
      lastError: null,
    }
  }

  const slice = page.slice(0, batchSize)
  let moved = 0
  let failed = 0
  let lastError: string | null = null
  const spendKey = PrivateKey.fromHex(args.candidate.rootKeyHex)
  const destLock = new P2PKH().lock(active.address).toHex()

  for (const item of slice) {
    await yieldToUi()
    try {
      await runExclusiveSpend(async () => {
        await migrateOneOrdinal(active, spendKey, destLock, item)
      })
      moved += 1
    } catch (err) {
      failed += 1
      lastError = err instanceof Error ? err.message : String(err)
      console.warn('[phrase-sweep] item migrate failed', item.outpoint, lastError)
    }
  }

  const next: ItemCursor = {
    ...cursor,
    offset: cursor.offset + slice.length,
    moved: cursor.moved + moved,
    failed: cursor.failed + failed,
  }
  const done = page.length < GP_PAGE && slice.length >= page.length
  if (done) writeItemCursor(null)
  else writeItemCursor(next)

  if (moved > 0) {
    try {
      await refreshFromChain({ forceReview: true, announceReceive: true })
    } catch (err) {
      console.warn('[phrase-sweep] post-migrate refresh failed', err)
    }
  }

  return {
    moved: next.moved,
    failed: next.failed,
    scanned: next.offset,
    done,
    lastError,
  }
}

async function migrateOneOrdinal(
  active: ActiveWallet,
  spendKey: PrivateKey,
  destLockHex: string,
  item: { outpoint: string; origin?: string; name?: string },
): Promise<void> {
  const [txidPart] = item.outpoint.split('.')
  const txid = (txidPart ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('Bad outpoint')

  const built = await buildLegacyInputBeef(active.services, [item.outpoint])
  if (built.ready.length === 0 || built.beef.length === 0) {
    throw new Error(built.failures[0]?.reason ?? 'Could not load tip BEEF')
  }

  const origin = (item.origin ?? item.outpoint).replace(/_(\d+)$/, '.$1')
  const customInstructions = buildInternalizeCustomInstructions({
    origin,
    name: (item.name ?? 'Collectable').slice(0, 40),
  })

  const car = await active.wallet.createAction({
    inputBEEF: built.beef,
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
    unsignedTx.inputs[inputIndex]!.unlockingScriptTemplate = SetupClient.getUnlockP2PKH(
      spendKey,
      1,
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
  packed.mergeBeef(built.beef)
  packed.mergeBeef(sweepAtomic)
  packed.atomicTxid = undefined
  const bin = packed.toBinaryAtomic(sweepTxid)
  if (!active.services?.postBeef) throw new Error('No broadcast service')
  const results = await active.services.postBeef(Beef.fromBinary(bin), [sweepTxid])
  const summary = summarizePostBeef(results as never)
  if (!summary.accepted) {
    throw new Error(`Broadcast rejected (${summary.detail})`)
  }
}
