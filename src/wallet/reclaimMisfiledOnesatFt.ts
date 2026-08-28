/**
 * Unused by ingest. Tokens are listed from basket `1sat-ft` only.
 * Do not scan basket `1sat` to recover FTs.
 */
import { Transaction } from '@bsv/sdk'
import { getAtomicBeefBinaryForTxid, getLocalBeefForTxid } from './beefCache'
import {
  buildColourCustomInstructions,
  colourTags,
  isOnesatFtMime,
  normalizeColourOrigin,
  ONESAT_FT_BASKET,
  originFromColourTags,
  parseOnesatFtOriginPolicy,
  type ColourSupply,
} from './colourCoins'
import { scheduleHistoryBackupPush } from './deviceSync'
import { stampBrc164Id } from './itemAccess'
import {
  forgetOneSatImported,
  markOneSatImported,
} from './oneSatImportGuard'
import { fetchRawTxHex } from './oneSatImport'
import { parseOrdEnvelope } from './ordinalOwnership'
import { getActiveWallet, type ActiveWallet } from './session'


function lockingScriptHex(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) return raw
  if (raw && typeof raw === 'object') {
    const o = raw as { toHex?: () => string; hex?: string }
    if (typeof o.toHex === 'function') {
      try {
        const hex = o.toHex()
        if (hex) return hex
      } catch {
        /* ignore */
      }
    }
    if (typeof o.hex === 'string' && o.hex) return o.hex
  }
  return undefined
}

async function beefBytesForFtInternalize(
  wallet: ActiveWallet,
  txid: string,
): Promise<number[]> {
  const local = await getLocalBeefForTxid(wallet, txid)
  if (local?.findTxid(txid)?.tx) {
    try {
      return Array.from(local.toBinaryAtomic(txid))
    } catch {
      return Array.from(local.toBinary())
    }
  }
  return getAtomicBeefBinaryForTxid(wallet, txid)
}

function iconFromSibling(
  tx: Transaction,
  originTxid: string,
  tipVout: number,
): string | undefined {
  for (let i = 0; i < (tx.outputs?.length ?? 0); i++) {
    if (i === tipVout) continue
    const out = tx.outputs[i]
    if (!out || out.satoshis !== 1) continue
    const env = parseOrdEnvelope(out.lockingScript?.toHex())
    const mime = (env?.contentType ?? '').toLowerCase()
    if (mime.startsWith('image/')) return `${originTxid}_${i}`
  }
  return undefined
}

const VIN_PROBE_LIMIT = 4
const LINEAGE_DEPTH = 6
/** Cap network walks per pass — large NFT baskets must stay snappy. */
const MAX_LINEAGE_PROBES = 32

type FtBinding = {
  origin: string
  amt: number
  sym: string
  supply: ColourSupply
  maxSupply: number | null
  icon?: string
}

function wireOutpoint(op: string): string {
  return op.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
}

function parseAmtFromJson(o: Record<string, unknown>): number | null {
  const raw = o.amt
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim())
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  return null
}

function parseCiBinding(ci: unknown): Partial<FtBinding> | null {
  if (ci == null) return null
  let o: Record<string, unknown> | null = null
  if (typeof ci === 'string') {
    try {
      o = JSON.parse(ci) as Record<string, unknown>
    } catch {
      return null
    }
  } else if (typeof ci === 'object') {
    o = ci as Record<string, unknown>
  }
  if (!o) return null
  const p = String(o.p ?? '').toLowerCase()
  if (p !== '1sat-ft') return null
  let origin: string | undefined
  try {
    if (typeof o.origin === 'string' && o.origin.trim()) {
      origin = normalizeColourOrigin(o.origin)
    }
  } catch {
    origin = undefined
  }
  const amt = parseAmtFromJson(o)
  const sym =
    typeof o.sym === 'string' && o.sym.trim()
      ? o.sym.trim().slice(0, 32)
      : typeof o.name === 'string' && o.name.trim()
        ? o.name.trim().slice(0, 32)
        : undefined
  return {
    ...(origin ? { origin } : {}),
    ...(amt != null ? { amt } : {}),
    ...(sym ? { sym } : {}),
  }
}

function ftBindingFromListedScript(
  txid: string,
  vout: number,
  scriptHex: string | undefined,
): FtBinding | null {
  if (!scriptHex) return null
  const env = parseOrdEnvelope(scriptHex)
  if (!env || !isOnesatFtMime(env.contentType)) return null
  const origin = `${txid}_${vout}`
  let policy
  try {
    policy = parseOnesatFtOriginPolicy(origin, { lockingScriptHex: scriptHex })
  } catch {
    return null
  }
  let amt = 1
  if (env.body?.length) {
    try {
      const json = JSON.parse(new TextDecoder().decode(env.body)) as Record<
        string,
        unknown
      >
      amt = parseAmtFromJson(json) ?? 1
    } catch {
      amt = 1
    }
  }
  return {
    origin: policy.origin,
    amt,
    sym: policy.sym ?? policy.name ?? 'Token',
    supply: policy.supply,
    maxSupply: policy.maxSupply,
    ...(policy.icon ? { icon: policy.icon } : {}),
  }
}

async function ftBindingFromLineage(
  txid: string,
  vout: number,
  chain: ActiveWallet['chain'],
  depth: number,
  seen: Set<string>,
): Promise<FtBinding | null> {
  if (depth <= 0) return null
  const hex = await fetchRawTxHex(txid, chain)
  if (!hex) return null
  let tx: Transaction
  try {
    tx = Transaction.fromHex(hex)
  } catch {
    return null
  }
  const out = tx.outputs[vout]
  if (!out || out.satoshis !== 1) return null
  const scriptHex = out.lockingScript?.toHex()
  const env = parseOrdEnvelope(scriptHex)
  if (env && isOnesatFtMime(env.contentType)) {
    const origin = `${txid}_${vout}`
    const policy = parseOnesatFtOriginPolicy(origin, {
      lockingScriptHex: scriptHex,
    })
    let amt = 1
    if (env.body?.length) {
      try {
        const json = JSON.parse(new TextDecoder().decode(env.body)) as Record<
          string,
          unknown
        >
        amt = parseAmtFromJson(json) ?? 1
      } catch {
        amt = 1
      }
    }
    return {
      origin: policy.origin,
      amt,
      sym: policy.sym ?? policy.name ?? 'Token',
      supply: policy.supply,
      maxSupply: policy.maxSupply,
      ...(policy.icon ? { icon: policy.icon } : {}),
    }
  }
  if (env) return null // other inscription ⇒ not FT misfile

  for (const input of tx.inputs.slice(0, VIN_PROBE_LIMIT)) {
    const sourceTxid = input.sourceTXID?.trim().toLowerCase()
    const sourceVout = input.sourceOutputIndex
    if (!sourceTxid || !Number.isInteger(sourceVout)) continue
    const key = `${sourceTxid}:${sourceVout}`
    if (seen.has(key)) continue
    seen.add(key)
    const nested = await ftBindingFromLineage(
      sourceTxid,
      sourceVout!,
      chain,
      depth - 1,
      seen,
    )
    if (nested) return nested
  }
  return null
}

export type ReclaimMisfiledFtResult = {
  droppedDuplicates: number
  moved: number
  failed: number
}

function rowSaysOnesatFt(
  tags: unknown,
  ci: unknown,
  scriptHex?: string,
): boolean {
  if (Array.isArray(tags)) {
    const hit = tags.some(
      (t) => typeof t === 'string' && t.trim().toLowerCase() === '1sat-ft',
    )
    if (hit) return true
  }
  if (ci != null) {
    let o: Record<string, unknown> | null = null
    if (typeof ci === 'string') {
      try {
        o = JSON.parse(ci) as Record<string, unknown>
      } catch {
        o = null
      }
    } else if (typeof ci === 'object') {
      o = ci as Record<string, unknown>
    }
    const nested =
      o && o.colour && typeof o.colour === 'object' && !Array.isArray(o.colour)
        ? (o.colour as Record<string, unknown>)
        : o
    if (nested && String(nested.p ?? '').toLowerCase() === '1sat-ft') return true
  }
  if (scriptHex) {
    const env = parseOrdEnvelope(scriptHex)
    if (env && isOnesatFtMime(env.contentType)) return true
  }
  return false
}


/**
 * Address-scan 1sat-ft tips that never entered basket `1sat-ft` (classify
 * used to park them as unknown). Local BEEF / raw tx only — no indexer.
 */

async function paintImportedFungible(
  binding: {
    origin: string
    sym: string
    amt: number
    supply?: string
    maxSupply?: number | null
    icon?: string
  },
  outpoint: string,
): Promise<void> {
  try {
    const { rememberFungibleToken } = await import('./fungibles')
    rememberFungibleToken({
      tokenId: binding.origin,
      sym: binding.sym,
      amt: String(binding.amt),
      dec: 0,
      utxoCount: 1,
      outpoint,
      spendKind: 'plain',
      colourSupply:
        binding.supply === 'locked' || binding.supply === 'open'
          ? binding.supply
          : undefined,
      colourMaxSupply: binding.maxSupply,
      colourProvenanceOk: true,
      ...(binding.icon ? { icon: binding.icon } : {}),
    })
  } catch (err) {
    console.warn('[1sat-ft-import] cache paint failed', outpoint, err)
  }
}

export async function importUnheldOnesatFtTips(
  wallet: ActiveWallet,
  rows: Array<{
    outpoint?: string
    txid?: string
    vout?: number
    satoshis?: number
  }>,
  alreadyHeld: Set<string>,
): Promise<{ imported: number; failed: number }> {
  let imported = 0
  let failed = 0
  const seen = new Set<string>()
  const extra: typeof rows = []
  try {
    const listed = (await wallet.wallet.listOutputs({
      basket: '1sat',
      limit: 2000,
      include: 'locking scripts',
      includeCustomInstructions: true,
      includeTags: true,
      seekPermission: false,
    })) as unknown as { outputs?: Array<Record<string, unknown>> }
    for (const o of listed.outputs ?? []) {
      const script = lockingScriptHex(o.lockingScript)
      const env = parseOrdEnvelope(script)
      if (!env || !isOnesatFtMime(env.contentType)) continue
      extra.push({ outpoint: String(o.outpoint ?? ''), satoshis: 1 })
    }
  } catch {
    /* scan rows still run */
  }
  for (const row of [...extra, ...rows]) {
    const rawOp = String(row.outpoint ?? (row.txid != null && row.vout != null ? `${row.txid}.${row.vout}` : ''))
    const op = wireOutpoint(rawOp)
    if (!op || seen.has(op)) continue
    if (typeof row.satoshis === 'number' && row.satoshis !== 1) continue
    seen.add(op)
    const [txid, vOut] = op.split('.')
    const vout = Number(vOut)
    if (!txid || !Number.isInteger(vout)) continue
    const hex = await fetchRawTxHex(txid, wallet.chain)
    if (!hex) continue
    let tx: Transaction
    try {
      tx = Transaction.fromHex(hex)
    } catch {
      continue
    }
    let atomic: number[] | null = null
    for (let i = 0; i < (tx.outputs?.length ?? 0); i++) {
      const tip = tx.outputs[i]
      if (!tip || tip.satoshis !== 1) continue
      const tipOp = `${txid}.${i}`
      if (alreadyHeld.has(tipOp) || (seen.has(tipOp) && i !== vout)) {
        const heldBinding = ftBindingFromListedScript(txid, i, tip.lockingScript?.toHex())
        if (heldBinding) {
          let painted = heldBinding
          if (!painted.icon) {
            const icon = iconFromSibling(tx, txid, i)
            if (icon) painted = { ...painted, icon }
          }
          await paintImportedFungible(painted, `${txid}_${i}`)
        }
        continue
      }
      seen.add(tipOp)
      let binding = ftBindingFromListedScript(txid, i, tip.lockingScript?.toHex())
      if (!binding) continue
      if (!binding.icon) {
        const icon = iconFromSibling(tx, txid, i)
        if (icon) binding = { ...binding, icon }
      }
      try {
        atomic = atomic ?? (await beefBytesForFtInternalize(wallet, txid))
        await wallet.wallet.internalizeAction({
          tx: atomic,
          description: `Import ${binding.sym}`.slice(0, 50),
          labels: [ONESAT_FT_BASKET, 'handcash-1sat-ft-import'],
          outputs: [
            {
              outputIndex: i,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: ONESAT_FT_BASKET,
                tags: stampBrc164Id(
                  colourTags(binding.origin, [`name:${binding.sym.slice(0, 80)}`]),
                ),
                customInstructions: buildColourCustomInstructions({
                  origin: binding.origin,
                  sym: binding.sym,
                  name: binding.sym,
                  amt: binding.amt,
                  supply: binding.supply,
                  maxSupply: binding.maxSupply,
                  ...(binding.icon ? { icon: binding.icon } : {}),
                }),
              },
            },
          ],
          seekPermission: false,
        })
        alreadyHeld.add(tipOp)
        imported++
        await paintImportedFungible(binding, `${txid}_${i}`)
      } catch (err) {
        failed++
        console.warn('[1sat-ft-import] failed', tipOp, err)
      }
    }
  }
  if (imported > 0) {
    console.info(`[1sat-ft-import] internalized ${imported} tip(s)`)
    scheduleHistoryBackupPush('importUnheldOnesatFtTips')
    void import('./fungibles')
      .then(({ listFungibles }) => listFungibles(wallet))
      .catch(() => {})
  }
  return { imported, failed }
}

/**
 * One pass: drop NFT duplicates of tips already in `1sat-ft`, move bare FT
 * lineage tips from `1sat` → `1sat-ft`.
 */
export async function reclaimMisfiledOnesatFtTips(
  active?: ActiveWallet | null,
): Promise<ReclaimMisfiledFtResult> {
  const wallet = active ?? getActiveWallet()
  const result: ReclaimMisfiledFtResult = {
    droppedDuplicates: 0,
    moved: 0,
    failed: 0,
  }
  if (!wallet) return result
  console.info('[1sat-ft-reclaim] start')

  try {
    const { getCachedCollectables } = await import('./collectables')
    const { getCachedFungibles } = await import('./fungibles')
    const cacheOrigins = new Set<string>()
    const cacheOps = new Set<string>()
    for (const tok of getCachedFungibles()) {
      const id = String(tok.tokenId ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.(\d+)$/, '_$1')
      if (id) cacheOrigins.add(id)
      const op = wireOutpoint(tok.outpoint)
      if (op) {
        cacheOps.add(op)
        cacheOrigins.add(op.replace('.', '_'))
      }
    }
    for (const item of getCachedCollectables()) {
      const op = wireOutpoint(item.outpoint)
      const origin = String(item.origin ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.(\d+)$/, '_$1')
      if (!op) continue
      // Only drop NFT copies of tips already in 1sat-ft. A bare-origin KING
      // genesis is a real token — move it in the candidate pass, do not drop.
      if (!cacheOps.has(op) && !(origin && cacheOrigins.has(origin))) continue
      try {
        await wallet.wallet.relinquishOutput({ basket: '1sat', output: op })
        forgetOneSatImported([op])
        result.droppedDuplicates++
      } catch (err) {
        result.failed++
        console.warn('[1sat-ft-reclaim] cache drop failed', op, err)
      }
    }
  } catch (err) {
    console.warn('[1sat-ft-reclaim] cache pass skipped', err)
  }

  const listBasket = async (args: Record<string, unknown>) => {
    try {
      return (await Promise.race([
        wallet.wallet.listOutputs(args as never),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('listOutputs timed out')), 8000),
        ),
      ])) as unknown as { outputs?: Array<Record<string, unknown>> }
    } catch (err) {
      console.warn('[1sat-ft-reclaim] listOutputs skipped', err)
      return { outputs: [] }
    }
  }

  const nftListed = await listBasket({
    basket: '1sat',
    limit: 2000,
    includeTags: true,
    includeCustomInstructions: true,
    include: 'locking scripts',
    seekPermission: false,
  })
  const ftListed = await listBasket({
    basket: ONESAT_FT_BASKET,
    limit: 2000,
    includeTags: true,
    includeCustomInstructions: true,
    seekPermission: false,
  })
  const ftOps = new Set<string>()
  const ftOrigins = new Set<string>()
  const ftGenesisTxids = new Set<string>()
  for (const o of ftListed.outputs ?? []) {
    const op = wireOutpoint(String(o.outpoint ?? ''))
    if (!op) continue
    ftOps.add(op)
    ftOrigins.add(op.replace('.', '_'))
    const tagOrigin = originFromColourTags((o as { tags?: unknown }).tags)
    const ci = parseCiBinding(o.customInstructions)
    if (tagOrigin) {
      ftOrigins.add(tagOrigin)
      const tx = tagOrigin.split('_')[0]
      if (tx) ftGenesisTxids.add(tx)
    }
    if (ci?.origin) {
      ftOrigins.add(ci.origin)
      const tx = ci.origin.split('_')[0]
      if (tx) ftGenesisTxids.add(tx)
    }
  }
  const nftRows = (nftListed.outputs ?? []).filter((o) => {
    const sats =
      typeof o.satoshis === 'number'
        ? o.satoshis
        : Number((o as { satoshis?: unknown }).satoshis)
    return sats === 1
  })

  const dropOps: string[] = []
  const candidates: Array<{
    outpoint: string
    txid: string
    vout: number
    ci: unknown
    tags?: unknown
    scriptHex?: string
  }> = []

  for (const row of nftRows) {
    const op = wireOutpoint(String(row.outpoint ?? ''))
    if (ftOps.has(op)) {
      dropOps.push(op)
      continue
    }
    const [txid, vOut] = op.split('.')
    const vout = Number(vOut)
    if (!txid || !Number.isInteger(vout)) continue
    const scriptHex = lockingScriptHex(row.lockingScript)
    const tags = (row as { tags?: unknown }).tags
    const env = parseOrdEnvelope(scriptHex)
    const saysFt = rowSaysOnesatFt(tags, row.customInstructions, scriptHex)
    const rowOrigin = originFromColourTags(tags)
    // Leftover extras: NFT copy / icon of a tip already restored to 1sat-ft.
    if (rowOrigin && ftOrigins.has(rowOrigin)) {
      dropOps.push(op)
      continue
    }
    if (
      env &&
      (env.contentType ?? '').toLowerCase().startsWith('image/') &&
      ftGenesisTxids.has(txid)
    ) {
      dropOps.push(op)
      continue
    }
    // Inscribed non-FT NFTs stay unless remittance already says 1sat-ft.
    // Do not treat collectable `origin:` tags as FT — those are NFT remittance.
    if (env && !isOnesatFtMime(env.contentType) && !saysFt) continue
    candidates.push({
      outpoint: op,
      txid,
      vout,
      ci: row.customInstructions,
      tags,
      scriptHex,
    })
  }

  for (const op of dropOps) {
    try {
      await wallet.wallet.relinquishOutput({
        basket: '1sat',
        output: op,
      })
      result.droppedDuplicates++
      forgetOneSatImported([op])
    } catch (err) {
      result.failed++
      console.warn('[1sat-ft-reclaim] drop duplicate failed', op, err)
    }
  }

  let probes = 0
  const moveOps: string[] = []
  for (const cand of candidates) {
    const fromCi = parseCiBinding(cand.ci)
    const tagOrigin = rowSaysOnesatFt(cand.tags, cand.ci, cand.scriptHex)
      ? originFromColourTags(cand.tags)
      : null
    let binding: FtBinding | null = ftBindingFromListedScript(
      cand.txid,
      cand.vout,
      cand.scriptHex,
    )
    if (!binding && fromCi?.origin) {
      binding = {
        origin: fromCi.origin,
        amt: fromCi.amt ?? 1,
        sym: fromCi.sym ?? 'Token',
        supply: 'open',
        maxSupply: null,
      }
    } else if (!binding && tagOrigin) {
      binding = {
        origin: tagOrigin,
        amt: 1,
        sym: 'Token',
        supply: 'open',
        maxSupply: null,
      }
    }
    if (!binding) {
      if (probes >= MAX_LINEAGE_PROBES) continue
      probes++
      binding = await ftBindingFromLineage(
        cand.txid,
        cand.vout,
        wallet.chain,
        LINEAGE_DEPTH,
        new Set(),
      )
    }
    if (!binding) continue
    if (fromCi?.amt != null) binding = { ...binding, amt: fromCi.amt }
    if (fromCi?.sym) binding = { ...binding, sym: fromCi.sym }

    if (!binding.icon && cand.scriptHex) {
      try {
        const hex = await fetchRawTxHex(cand.txid, wallet.chain)
        if (hex) {
          const tx = Transaction.fromHex(hex)
          const icon = iconFromSibling(tx, cand.txid, cand.vout)
          if (icon) binding = { ...binding, icon }
        }
      } catch {
        /* icon is optional */
      }
    }
    try {
      await wallet.wallet.relinquishOutput({
        basket: '1sat',
        output: cand.outpoint,
      })
      forgetOneSatImported([cand.outpoint])

      const atomic = await beefBytesForFtInternalize(wallet, cand.txid)
      await wallet.wallet.internalizeAction({
        tx: atomic,
        description: `Reclaim ${binding.sym}`.slice(0, 50),
        labels: [ONESAT_FT_BASKET, 'handcash-1sat-ft-reclaim'],
        outputs: [
          {
            outputIndex: cand.vout,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: ONESAT_FT_BASKET,
              tags: stampBrc164Id(
                colourTags(binding.origin, [`name:${binding.sym.slice(0, 80)}`]),
              ),
              customInstructions: buildColourCustomInstructions({
                origin: binding.origin,
                sym: binding.sym,
                name: binding.sym,
                amt: binding.amt,
                supply: binding.supply,
                maxSupply: binding.maxSupply,
                ...(binding.icon ? { icon: binding.icon } : {}),
              }),
            },
          },
        ],
        seekPermission: false,
      })
      markOneSatImported([cand.outpoint])
      moveOps.push(cand.outpoint)
      result.moved++
      await paintImportedFungible(binding, cand.outpoint.includes('.') ? cand.outpoint.replace('.', '_') : cand.outpoint)
    } catch (err) {
      result.failed++
      console.warn('[1sat-ft-reclaim] move failed', cand.outpoint, err)
    }
  }

  if (dropOps.length > 0 || moveOps.length > 0) {
    scheduleHistoryBackupPush('reclaimMisfiledOnesatFt')
    void import('./fungibles')
      .then(({ listFungibles }) => listFungibles(wallet))
      .catch(() => {})
    try {
      const { listCollectables, invalidateLiveOneSatOutpoints } =
        await import('./collectables')
      invalidateLiveOneSatOutpoints()
      void listCollectables(wallet).catch(() => {})
    } catch {
      /* ignore */
    }
  }
  console.info(
    `[1sat-ft-reclaim] nft=${nftRows.length} candidates=${candidates.length} dropped ${result.droppedDuplicates} NFT duplicate(s), moved ${result.moved} tip(s) to 1sat-ft` +
      (result.failed ? `, failed ${result.failed}` : '') +
      (probes ? `, lineageProbes=${probes}` : ''),
  )

  return result
}
