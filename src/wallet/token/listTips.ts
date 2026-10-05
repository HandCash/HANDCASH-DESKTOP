import { issuerMetadataFromScript } from '../issuerMetadata'
import { retainedIssuerMetadata } from '../issuerAttribution'
import { tokenIssuerAttested } from './lineage'
import { getActiveWallet } from '../session'
import { getWalletRuntime } from '../walletRuntime'

/** List BRC-162 value tips from basket `bsv21` (BRC-163). */
import { type ActiveWallet } from '../session'
import {
  aggregateFungibles,
  BSV21_BASKET,
  cosignFromRemittance,
  detectCosignFromLockingScript,
  issuerFromRemittance,
  issuerFromSigmaLockingScript,
  isBalanceBearingOp,
  normalizeTokenId,
  parseBsv21CustomInstructions,
  parseBsv21Json,
  type Bsv21Op,
  type Bsv21Utxo,
} from './types'
import { Transaction, Utils } from '@bsv/sdk'
import { decodeBsv21Binary, iconOutpointFromPayload } from './decode162'
import { tipFromBsv21Script } from './sendPlan'
import { durableGetItem, durableSetItem } from '../durableStorage'
import {
  forgetItemsSent,
  getSentItemRecord,
  isItemSent,
} from '../sentItemGuard'
import { parseOrdEnvelope, scriptPaysAddress } from '../ordinalOwnership'
import { looksLikeRetiredFungibleTip } from '../retiredFungible'
import { uiBudgetExpired, yieldToUi } from '../yieldToUi'

const DEPLOY_CAP_KEY = 'handcash.bsv21.deploy-cap.v1'

function readDeployCapMap(): Record<string, number> {
  try {
    const raw = durableGetItem(DEPLOY_CAP_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(v)
      if (Number.isSafeInteger(n) && n > 0) out[k.toLowerCase()] = n
    }
    return out
  } catch {
    return {}
  }
}

function rememberDeployCap(tokenId: string, cap: number): void {
  const id = tokenId.trim().toLowerCase()
  if (!id || !Number.isSafeInteger(cap) || cap <= 0) return
  const map = readDeployCapMap()
  if (map[id] === cap) return
  map[id] = cap
  durableSetItem(DEPLOY_CAP_KEY, JSON.stringify(map))
}

export function rememberedDeployCap(tokenId: string): number | undefined {
  const n = readDeployCapMap()[tokenId.trim().toLowerCase()]
  return n
}

function maxSupplyFromCi(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as { maxSupply?: unknown }
    const n = Number(parsed.maxSupply)
    return Number.isSafeInteger(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

async function capFromLocalDeploy(
  wallet: ActiveWallet,
  tokenId: string,
): Promise<number | undefined> {
  const id = normalizeTokenId(tokenId) ?? tokenId.trim().toLowerCase()
  const remembered = rememberedDeployCap(id)
  if (remembered) return remembered
  const m = /^([0-9a-f]{64})_(\d+)$/i.exec(id)
  if (!m) return undefined
  const txid = m[1]!.toLowerCase()
  const vout = Number(m[2])
  // Script only — a raw body read, not a toolbox BEEF assembly per token.
  const { getLocalTxForTxid } = await import('../beefCache')
  const tx = await getLocalTxForTxid(wallet, txid)
  const script = tx?.outputs?.[vout]?.lockingScript
  if (!script) return undefined
  const hex = typeof script.toHex === 'function' ? script.toHex() : String(script)
  const decoded = decodeBsv21Binary(hex)
  if (!decoded || decoded.role !== 'deploy') return undefined
  const n = Number(decoded.amount)
  if (!Number.isSafeInteger(n) || n <= 0) return undefined
  rememberDeployCap(id, n)
  return n
}


type ListedOutput = {
  outpoint?: string
  satoshis?: number
  tags?: string[]
  basket?: string
  lockingScript?: string | { toHex?: () => string }
  customInstructions?: string
}

function lockingScriptHex(raw: ListedOutput['lockingScript']): string | undefined {
  if (!raw) return undefined
  if (typeof raw === 'string') return raw
  if (typeof raw.toHex === 'function') return raw.toHex()
  return undefined
}

function outpointUnderscore(op: string): string {
  return op.includes('.') ? op.replace(/\.(\d+)$/, '_$1') : op
}

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  for (const tag of tags) {
    if (tag.startsWith(prefix)) {
      const v = tag.slice(prefix.length).trim()
      if (v) return v
    }
  }
  return undefined
}

/**
 * Decode a listed basket row as BRC-162 / BRC-163.
 * Script amount wins. CI/tags supply id, dec, and symbol.
 */
export function decodeListedBsv21Tip(raw: ListedOutput, identityKey?: string): Bsv21Utxo | null {
  const outpointRaw = (raw.outpoint ?? '').trim()
  if (!outpointRaw) return null
  const satoshis = typeof raw.satoshis === 'number' ? raw.satoshis : 1
  if (satoshis !== 1) return null
  const scriptHex = lockingScriptHex(raw.lockingScript)
  if (!scriptHex) return null
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : []
  if (
    looksLikeRetiredFungibleTip({
      tags,
      customInstructions: raw.customInstructions,
      lockingScriptHex: scriptHex,
    })
  ) {
    return null
  }

  const decoded = decodeBsv21Binary(scriptHex)
  if (!decoded) return null
  const fromScript = tipFromBsv21Script({
    outpoint: outpointRaw,
    lockingScript: scriptHex,
    satoshis,
    customInstructions: raw.customInstructions,
    tags,
  })
  if (!fromScript) return null
  const fromCi = parseBsv21CustomInstructions(raw.customInstructions)
  const tokenId = fromScript.tokenId
  const amt = fromScript.amt.toString()
  if (!tokenId || !amt) return null
  const op = (
    decoded?.role === 'deploy' || fromCi?.op === 'deploy+mint'
      ? 'deploy+mint'
      : (fromCi?.op ?? 'transfer')
  ) as Bsv21Op
  const sym = fromCi?.sym ?? decoded?.payload?.sym ?? tagValue(tags, 'sym:')
  const dec = fromCi?.dec ?? decoded?.payload?.dec ?? 0
  const icon =
    iconOutpointFromPayload(decoded.payload?.icon, tokenId) ?? fromCi?.icon
  const maxN = Number(amt)
  const maxSupply =
    op === 'deploy+mint' && Number.isSafeInteger(maxN) && maxN > 0
      ? maxN
      : maxSupplyFromCi(
          typeof raw.customInstructions === 'string' ? raw.customInstructions : undefined,
        ) ?? rememberedDeployCap(tokenId)
  if (maxSupply != null) rememberDeployCap(tokenId, maxSupply)
  const original = retainedIssuerMetadata(tokenId)
  const metadata = original?.issuer ? original : issuerMetadataFromScript(scriptHex)
  const remittanceIssuer = metadata.issuer ?? issuerFromRemittance({
    customInstructions: raw.customInstructions,
    tags,
  })
  const sigma = issuerFromSigmaLockingScript(
    scriptHex,
    [remittanceIssuer, identityKey].filter(Boolean) as string[],
  )
  const issuer = sigma.issuer ?? remittanceIssuer
  // Only the deploy output carries the issuer's Sigma; a transfer tip borrows
  // it once a BRC-176 walk bound the tip to that deploy.
  const issuerAttested = tokenIssuerAttested({
    outpoint: outpointRaw,
    tokenId,
    issuer,
    lockingScript: scriptHex,
  })
  // Script wins for the lock kind (BRC-163: readers prefer the script when
  // trust matters); remittance only fills a cosign claim the rest lacks.
  const cosign =
    detectCosignFromLockingScript(decoded.restScriptHex) ??
    cosignFromRemittance({ customInstructions: raw.customInstructions, tags })
  return {
    outpoint: outpointUnderscore(outpointRaw).toLowerCase(),
    tokenId,
    amt,
    op,
    dec,
    satoshis: 1,
    binarySupply: 'locked',
    encoding: 'brc162',
    ...(sym ? { sym } : {}),
    ...(icon ? { icon } : {}),
    ...(maxSupply != null ? { maxSupply } : {}),
    ...(scriptHex ? { lockingScript: scriptHex } : {}),
    ...(issuer ? { issuer } : {}),
    ...(issuerAttested ? { issuerAttested: true } : {}),
    ...(metadata.bapId ? { bapId: metadata.bapId } : {}),
    ...(cosign ? { cosign } : {}),
  }
}

/**
 * Decode a listed basket row whose script carries a BRC-161 JSON inscription.
 *
 * The amount and id come from the inscription on the script itself — never
 * from remittance or tags, which are metadata a basket row can carry without
 * holding the token.
 */
export function decodeListedLegacyTip(raw: ListedOutput): Bsv21Utxo | null {
  const outpointRaw = (raw.outpoint ?? '').trim()
  if (!outpointRaw) return null
  if ((typeof raw.satoshis === 'number' ? raw.satoshis : 1) !== 1) return null
  const scriptHex = lockingScriptHex(raw.lockingScript)
  if (!scriptHex || decodeBsv21Binary(scriptHex)) return null
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : []
  if (
    looksLikeRetiredFungibleTip({
      tags,
      customInstructions: raw.customInstructions,
      lockingScriptHex: scriptHex,
    })
  ) {
    return null
  }
  const envelope = parseOrdEnvelope(scriptHex)
  if (!envelope?.body?.length) return null
  let payload: ReturnType<typeof parseBsv21Json> = null
  try {
    payload = parseBsv21Json(JSON.parse(new TextDecoder().decode(envelope.body)))
  } catch {
    return null
  }
  if (!payload?.amt || !isBalanceBearingOp(payload.op)) return null
  const outpoint = outpointUnderscore(outpointRaw).toLowerCase()
  const tokenId =
    payload.op === 'deploy+mint' ? normalizeTokenId(outpoint) : normalizeTokenId(payload.id ?? '')
  if (!tokenId || BigInt(payload.amt) <= 0n) return null
  const fromCi = parseBsv21CustomInstructions(raw.customInstructions)
  const sym = payload.sym ?? fromCi?.sym ?? tagValue(tags, 'sym:')
  const icon = payload.icon ?? fromCi?.icon
  return {
    outpoint,
    tokenId,
    amt: payload.amt,
    op: payload.op,
    dec: payload.dec ?? fromCi?.dec ?? 0,
    satoshis: 1,
    encoding: 'legacy-json',
    lockingScript: scriptHex,
    ...(sym ? { sym } : {}),
    ...(icon ? { icon } : {}),
  }
}

const remittanceOnlyNoted = new Set<string>()

/**
 * `[bsv21] remittance-only tip …` — parsed by `scripts/triage-logs.mjs`.
 * Says whether storage listed the row without a script or with one that is
 * not a 162 lock: send can only spend the second kind after a local-BEEF read.
 */
function noteRemittanceOnlyTip(outpoint: string, amt: string, scriptHex: string | undefined): void {
  if (remittanceOnlyNoted.has(outpoint)) return
  remittanceOnlyNoted.add(outpoint)
  const script = !scriptHex
    ? 'script absent'
    : `script ${scriptHex.length / 2}B ${
        decodeBsv21Binary(scriptHex)
          ? '162 lock the tip decode refused'
          : /^76a914[0-9a-f]{40}88ac$/i.test(scriptHex)
            ? 'plain p2pkh'
            : parseOrdEnvelope(scriptHex)
              ? 'ord envelope'
              : 'unrecognized'
      }`
  console.info(`[bsv21] remittance-only tip ${outpoint} amt=${amt} — ${script}`)
}

/**
 * A remittance-only row (plain script, token named in custom instructions)
 * that this wallet already held as that exact outpoint.
 *
 * Remittance is metadata, so it never introduces a token; it only keeps
 * projecting one the wallet held before inscriptions were kept on the row.
 */
function decodeContinuingRemittanceTip(
  raw: ListedOutput,
  continuing: ReadonlySet<string>,
): Bsv21Utxo | null {
  const outpoint = outpointUnderscore((raw.outpoint ?? '').trim()).toLowerCase()
  if (!outpoint || !continuing.has(outpoint)) return null
  if ((typeof raw.satoshis === 'number' ? raw.satoshis : 1) !== 1) return null
  const ci = parseBsv21CustomInstructions(raw.customInstructions)
  if (!ci?.amt || !isBalanceBearingOp(ci.op)) return null
  const tokenId =
    ci.op === 'deploy+mint' ? normalizeTokenId(outpoint) : normalizeTokenId(ci.id ?? '')
  if (!tokenId || !/^\d+$/.test(ci.amt) || BigInt(ci.amt) <= 0n) return null
  const scriptHex = lockingScriptHex(raw.lockingScript)
  noteRemittanceOnlyTip(outpoint, ci.amt, scriptHex)
  return {
    outpoint,
    tokenId,
    amt: ci.amt,
    op: ci.op,
    dec: ci.dec ?? 0,
    satoshis: 1,
    ...(scriptHex ? { lockingScript: scriptHex } : {}),
    ...(ci.sym ? { sym: ci.sym } : {}),
    ...(ci.icon ? { icon: ci.icon } : {}),
  }
}

/**
 * Un-hide a tip whose hide mark can only have been written by a different
 * wallet on this device.
 *
 * The guard exists because `listOutputs` keeps returning a tip a send already
 * spent, so "in our basket" alone cannot clear a mark. Two facts together can:
 * the tip pays **us**, and the hiding transaction is the tip's *own* — a spent
 * input is never an output of the transaction that spent it, and a payee
 * output the sender hid pays the payee, not the sender. What remains is the
 * receiving account reading a mark the sending account wrote when both shared
 * one device-wide store.
 *
 * Returns true when the tip may be listed.
 */
function healStaleReceivedHide(tip: Bsv21Utxo, wallet: ActiveWallet): boolean {
  const record = getSentItemRecord(tip.outpoint)
  const txid = tip.outpoint.split(/[._]/)[0]?.toLowerCase()
  if (!record?.txid || !txid || record.txid !== txid) return false
  if (!scriptPaysAddress(tip.lockingScript, wallet.address)) return false
  console.info(
    `[bsv21] clearing a hide mark on a tip we hold and are paid by — ${tip.outpoint}`,
  )
  forgetItemsSent([tip.outpoint])
  return true
}

/**
 * Shortest phase worth a log line. The uploaded log is triaged by code that
 * turns `<phase> done <N>ms` into a span and measures the freeze time inside
 * it; naming the basket read, the per-tip decode and the deploy-cap lookups
 * separately is what lets it say which one owns a stall.
 */
const PHASE_REPORT_MS = 250

function reportPhase(phase: string, startedAt: number, detail?: string): void {
  const ms = Date.now() - startedAt
  if (ms < PHASE_REPORT_MS) return
  console.info(`[bsv21] ${phase} done ${ms}ms${detail ? ` — ${detail}` : ''}`)
}

async function decodeHeldRows(
  wallet: ActiveWallet,
  rows: ListedOutput[],
  decode: (row: ListedOutput) => Bsv21Utxo | null,
): Promise<Bsv21Utxo[]> {
  const decodeStartedAt = Date.now()
  const tips: Bsv21Utxo[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    // Each decode may verify a Sigma signature; keep the thread answerable
    // between rows rather than for the whole basket.
    if (uiBudgetExpired()) await yieldToUi()
    const tip = decode(row)
    if (!tip) continue
    if (isItemSent(tip.outpoint) && !healStaleReceivedHide(tip, wallet)) {
      continue
    }
    if (seen.has(tip.outpoint)) continue
    seen.add(tip.outpoint)
    tips.push(tip)
  }
  reportPhase('tip-decode', decodeStartedAt, `${tips.length} tip(s)`)
  return tips
}

function splitOutpoint(outpoint: string | undefined): { txid: string; vout: number } | null {
  const m = /^([0-9a-f]{64})[._](\d+)$/i.exec((outpoint ?? '').trim())
  return m ? { txid: m[1]!.toLowerCase(), vout: Number(m[2]) } : null
}

/** The output's script when the body hashes to `txid` and the output is a one-sat BRC-162 lock. */
export function tokenLockFromBody(
  tx: Transaction | null | undefined,
  txid: string,
  vout: number,
): string | null {
  if (!tx || tx.id('hex') !== txid) return null
  const output = tx.outputs[vout]
  if (output?.satoshis !== 1) return null
  const hex = output.lockingScript.toHex()
  return decodeBsv21Binary(hex) ? hex : null
}

/** Outpoints whose transaction was already asked of the chain this session. */
const chainScriptAsked = new Set<string>()
const CHAIN_SCRIPT_READS_PER_PASS = 20

/**
 * Give a basket row storage listed without a lock the script its transaction
 * carries.
 *
 * BRC-162 puts the token fields in the output's on-chain locking script, and
 * BRC-163 admits a held tip by parsing that script — remittance is only a
 * claim. Storage can still hold a one-sat token row with no `lockingScript`
 * and no script offset to read one from; `listOutputs` then answers with
 * remittance only and the tip shows "encoding unverified" with send and burn
 * refused. The script is a fact of the transaction that created the output, so
 * any body whose hash is that txid settles it: the locally held one inline,
 * otherwise the chain's, off the list path. Only a script that decodes as a
 * BRC-162 lock is used, and it is written back so the next list, send and
 * listing read it from storage.
 */
async function withTokenScripts(
  wallet: ActiveWallet,
  rows: ListedOutput[],
): Promise<ListedOutput[]> {
  const unscripted = rows.filter(
    (row) =>
      !lockingScriptHex(row.lockingScript) &&
      (typeof row.satoshis === 'number' ? row.satoshis : 1) === 1 &&
      splitOutpoint(row.outpoint),
  )
  if (unscripted.length === 0) return rows
  const { getLocalTxForTxid } = await import('../beefCache')
  const filled = new Map<string, string>()
  const notLocal: string[] = []
  for (const row of unscripted) {
    const point = splitOutpoint(row.outpoint)!
    const hex = tokenLockFromBody(await getLocalTxForTxid(wallet, point.txid), point.txid, point.vout)
    if (hex) filled.set(row.outpoint!, hex)
    else notLocal.push(row.outpoint!)
  }
  if (filled.size > 0) {
    void persistTokenScripts(wallet, filled, 'local').catch(noteScriptHealFailure)
  }
  const ask = notLocal.filter((op) => !chainScriptAsked.has(op)).slice(0, CHAIN_SCRIPT_READS_PER_PASS)
  if (ask.length > 0) void readTokenScriptsFromChain(wallet, ask).catch(noteScriptHealFailure)
  if (filled.size === 0) return rows
  return rows.map((row) =>
    filled.has(row.outpoint!) ? { ...row, lockingScript: filled.get(row.outpoint!) } : row,
  )
}

function noteScriptHealFailure(err: unknown): void {
  console.warn('[bsv21] script heal skipped', err instanceof Error ? err.message : String(err))
}

async function readTokenScriptsFromChain(wallet: ActiveWallet, outpoints: string[]): Promise<void> {
  for (const op of outpoints) chainScriptAsked.add(op)
  const startedAt = Date.now()
  const { fetchRawTxHex } = await import('../oneSatImport')
  const filled = new Map<string, string>()
  for (const op of outpoints) {
    if (getWalletRuntime()?.instance !== wallet) return
    const point = splitOutpoint(op)!
    const raw = await fetchRawTxHex(point.txid, wallet.chain).catch(() => null)
    if (!raw) continue
    let tx: Transaction
    try {
      tx = Transaction.fromHex(raw)
    } catch {
      continue
    }
    const hex = tokenLockFromBody(tx, point.txid, point.vout)
    if (hex) filled.set(op, hex)
  }
  console.info(
    `[bsv21] chain script read done ${Date.now() - startedAt}ms — ${filled.size} of ${outpoints.length} unscripted row(s) carry a 162 lock`,
  )
  if (filled.size === 0 || getWalletRuntime()?.instance !== wallet) return
  await persistTokenScripts(wallet, filled, 'chain')
  const { listFungibles } = await import('./list')
  void listFungibles(wallet)
}

type ScriptHealStorage = {
  findUserByIdentityKey?: (identityKey: string) => Promise<{ userId: number } | undefined>
  findOutputs?: (args: {
    partial: { userId: number; txid: string; vout: number }
    noScript?: boolean
  }) => Promise<Array<{ outputId: number }> | undefined>
  updateOutput?: (id: number, update: { lockingScript: number[] }) => Promise<unknown>
}

async function persistTokenScripts(
  wallet: ActiveWallet,
  filled: Map<string, string>,
  source: 'local' | 'chain',
): Promise<void> {
  const storage = wallet.wallet?.storage
  if (!storage?.runAsStorageProvider) return
  const startedAt = Date.now()
  const healed = await storage.runAsStorageProvider(async (activeSp) => {
    const sp = activeSp as ScriptHealStorage
    if (
      typeof sp.findUserByIdentityKey !== 'function' ||
      typeof sp.findOutputs !== 'function' ||
      typeof sp.updateOutput !== 'function'
    ) {
      return 0
    }
    const user = await sp.findUserByIdentityKey(wallet.identityKey)
    if (!user) return 0
    let count = 0
    for (const [outpoint, hex] of filled) {
      const point = splitOutpoint(outpoint)!
      const found =
        (await sp.findOutputs({
          partial: { userId: user.userId, txid: point.txid, vout: point.vout },
          noScript: true,
        })) ?? []
      for (const row of found) {
        await sp.updateOutput(row.outputId, { lockingScript: Utils.toArray(hex, 'hex') })
        count += 1
      }
    }
    return count
  })
  console.info(
    `[bsv21] script heal done ${Date.now() - startedAt}ms — ${healed} token row(s) given the lock their transaction carries (${source})`,
  )
}

export async function listBsv21BinaryTips(
  wallet: ActiveWallet,
  opts: { includeCustomInstructions?: boolean } = {},
): Promise<Bsv21Utxo[]> {
  const readStartedAt = Date.now()
  const listed = await listBasketTips(wallet, BSV21_BASKET, {
    includeCustomInstructions: opts.includeCustomInstructions,
  })
  reportPhase('basket-read', readStartedAt, `${listed.length} row(s)`)
  const rows = await withTokenScripts(wallet, listed)
  return decodeHeldRows(wallet, rows, (row) => decodeListedBsv21Tip(row, wallet.identityKey))
}

/** Rows per basket page for the held-tokens projection. */
const HELD_PAGE_SIZE = 1000

/**
 * Every row of basket `bsv21`, all pages, or a throw.
 *
 * The token list is a projection of this answer, so a failed or truncated read
 * must never look like a smaller wallet: an error propagates and a page count
 * that does not reach the reported total refuses.
 */
async function readWholeBasket(wallet: ActiveWallet, basket: string): Promise<ListedOutput[]> {
  const rows: ListedOutput[] = []
  for (let offset = 0; ; offset += HELD_PAGE_SIZE) {
    const listed = (await wallet.wallet.listOutputs({
      basket,
      limit: HELD_PAGE_SIZE,
      offset,
      include: 'locking scripts',
      includeCustomInstructions: true,
      includeTags: true,
      seekPermission: false,
    })) as { outputs?: ListedOutput[]; totalOutputs?: number }
    const page = listed.outputs
    if (!Array.isArray(page)) throw new Error(`basket ${basket} answered without outputs`)
    rows.push(...page)
    const total = typeof listed.totalOutputs === 'number' ? listed.totalOutputs : null
    if (page.length < HELD_PAGE_SIZE) {
      if (total != null && rows.length < total) {
        throw new Error(`basket ${basket} listed ${rows.length} of ${total} row(s)`)
      }
      return rows
    }
    if (total != null && rows.length >= total) return rows
  }
}

/**
 * Every fungible tip the wallet holds in basket `bsv21`, both encodings —
 * the source the token list projects. Throws when the basket cannot answer
 * in full.
 */
export async function listHeldFungibleTips(
  wallet: ActiveWallet,
  opts: { continuing?: ReadonlySet<string> } = {},
): Promise<Bsv21Utxo[]> {
  const readStartedAt = Date.now()
  const rows = await withTokenScripts(wallet, await readWholeBasket(wallet, BSV21_BASKET))
  reportPhase('basket-read', readStartedAt, `${rows.length} row(s)`)
  const continuing = opts.continuing ?? new Set<string>()
  return decodeHeldRows(
    wallet,
    rows,
    (row) =>
      decodeListedBsv21Tip(row, wallet.identityKey) ??
      decodeListedLegacyTip(row) ??
      decodeContinuingRemittanceTip(row, continuing),
  )
}

/** Held tokens, aggregated by deploy, with deploy caps filled. Throws like {@link listHeldFungibleTips}. */
export async function listHeldFungibleTokens(
  wallet: ActiveWallet,
  opts: { continuing?: ReadonlySet<string> } = {},
): Promise<ReturnType<typeof aggregateFungibles>> {
  return withDeployCaps(wallet, aggregateFungibles(await listHeldFungibleTips(wallet, opts)))
}

export async function listBsv21BinaryTokens(
  wallet?: ActiveWallet | null,
): Promise<ReturnType<typeof aggregateFungibles>> {
  const active = wallet ?? getActiveWallet()
  if (!active) return []
  return withDeployCaps(active, aggregateFungibles(await listBsv21BinaryTips(active)))
}

async function withDeployCaps(
  active: ActiveWallet,
  tokens: ReturnType<typeof aggregateFungibles>,
): Promise<ReturnType<typeof aggregateFungibles>> {
  const capsStartedAt = Date.now()
  let lookups = 0
  for (const token of tokens) {
    if (token.binarySupply !== 'locked' || token.maxSupply != null) continue
    // Each miss walks local BEEF sources synchronously; give the UI a turn
    // between tokens.
    if (uiBudgetExpired()) await yieldToUi()
    lookups += 1
    const cap = await capFromLocalDeploy(active, token.tokenId)
    if (cap != null) token.maxSupply = cap
  }
  reportPhase('deploy-caps', capsStartedAt, `${lookups} lookup(s)`)
  return tokens
}


async function listBasketTips(
  wallet: ActiveWallet,
  basket: string,
  opts: { scripts?: boolean; includeCustomInstructions?: boolean } = {},
): Promise<ListedOutput[]> {
  try {
    const listed = (await wallet.wallet.listOutputs({
      basket,
      limit: 1000,
      ...(opts.scripts === false ? {} : { include: 'locking scripts' }),
      includeCustomInstructions: opts.includeCustomInstructions !== false,
      includeTags: true,
      seekPermission: false,
    })) as { outputs?: ListedOutput[] }
    return listed.outputs ?? []
  } catch {
    return []
  }
}


/** Stamp icon:<outpoint> on listed 162 rows when the deploy payload names one. */
export function stampBsv21IconOnListedOutputs(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const body = result as { outputs?: unknown[] }
  if (!Array.isArray(body.outputs)) return result
  return {
    ...body,
    outputs: body.outputs.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw
      const row = raw as ListedOutput
      const tip = decodeListedBsv21Tip(row)
      if (!tip?.icon) return raw
      const tags = Array.isArray(row.tags) ? [...row.tags.map(String)] : []
      if (!tags.some((t) => t.toLowerCase().startsWith('icon:'))) {
        tags.push(`icon:${tip.icon}`)
      }
      let custom = row.customInstructions
      if (typeof custom === 'string' && custom.trim()) {
        try {
          const o = JSON.parse(custom) as Record<string, unknown>
          if (o && typeof o === 'object' && typeof o.icon !== 'string') {
            o.icon = tip.icon
            custom = JSON.stringify(o)
          }
        } catch {
          /* keep original CI */
        }
      } else {
        custom = JSON.stringify({ p: 'bsv-20', icon: tip.icon, id: tip.tokenId, amt: tip.amt })
      }
      return { ...raw, tags, customInstructions: custom }
    }),
  }
}
