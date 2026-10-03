import { issuerMetadataFromScript } from '../issuerMetadata'
import { retainedIssuerMetadata } from '../issuerAttribution'
import { tokenIssuerAttested } from './lineage'
import { getActiveWallet } from '../session'

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

export async function listBsv21BinaryTips(
  wallet: ActiveWallet,
  opts: { includeCustomInstructions?: boolean } = {},
): Promise<Bsv21Utxo[]> {
  const readStartedAt = Date.now()
  const rows = await listBasketTips(wallet, BSV21_BASKET, {
    includeCustomInstructions: opts.includeCustomInstructions,
  })
  reportPhase('basket-read', readStartedAt, `${rows.length} row(s)`)
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
  const rows = await readWholeBasket(wallet, BSV21_BASKET)
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
