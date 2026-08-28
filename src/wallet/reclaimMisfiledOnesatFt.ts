/**
 * Heal 1sat-ft tips that address-scan painted into basket `1sat` (NFT).
 *
 * Bare FT transfers share the NFT tip-move shape; older probes filed them as
 * collectables. Relinquish the NFT row and re-insert under `1sat-ft` with
 * face-value CI when lineage reaches an `application/1sat-ft+json` ancestor.
 */
import { Transaction } from '@bsv/sdk'
import { getAtomicBeefBinaryForTxid } from './beefCache'
import {
  buildColourCustomInstructions,
  colourTags,
  isOnesatFtMime,
  normalizeColourOrigin,
  ONESAT_FT_BASKET,
  parseOnesatFtOriginPolicy,
  type ColourSupply,
} from './colourCoins'
import { listColourTokens } from './colourListing'
import { scheduleHistoryBackupPush } from './deviceSync'
import { stampBrc164Id } from './itemAccess'
import {
  forgetOneSatImported,
  markOneSatImported,
} from './oneSatImportGuard'
import { fetchRawTxHex } from './oneSatImport'
import { parseOrdEnvelope } from './ordinalOwnership'
import { getActiveWallet, type ActiveWallet } from './session'

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
  if (p && p !== '1sat-ft') return null
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

  const nftListed = await wallet.wallet.listOutputs({
    basket: '1sat',
    limit: 2000,
    includeTags: true,
    includeCustomInstructions: true,
    include: 'locking scripts',
    seekPermission: false,
  })
  const ftListed = await wallet.wallet.listOutputs({
    basket: ONESAT_FT_BASKET,
    limit: 2000,
    seekPermission: false,
  })
  const ftOps = new Set(
    (ftListed.outputs ?? []).map((o) => wireOutpoint(o.outpoint)),
  )
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
    scriptHex?: string
  }> = []

  for (const row of nftRows) {
    const op = wireOutpoint(row.outpoint)
    if (ftOps.has(op)) {
      dropOps.push(op)
      continue
    }
    const [txid, vOut] = op.split('.')
    const vout = Number(vOut)
    if (!txid || !Number.isInteger(vout)) continue
    const scriptHex =
      typeof row.lockingScript === 'string' ? row.lockingScript : undefined
    const env = parseOrdEnvelope(scriptHex)
    // Inscribed non-FT NFTs stay. Inscribed FT mints should not be in 1sat —
    // move them. Bare tips need a lineage probe.
    if (env && !isOnesatFtMime(env.contentType)) continue
    candidates.push({
      outpoint: op,
      txid,
      vout,
      ci: row.customInstructions,
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
    } catch (err) {
      result.failed++
      console.warn('[1sat-ft-reclaim] drop duplicate failed', op, err)
    }
  }

  let probes = 0
  const moveOps: string[] = []
  for (const cand of candidates) {
    if (probes >= MAX_LINEAGE_PROBES) break
    const fromCi = parseCiBinding(cand.ci)
    let binding: FtBinding | null = null
    if (cand.scriptHex && parseOrdEnvelope(cand.scriptHex)) {
      const env = parseOrdEnvelope(cand.scriptHex)
      if (env && isOnesatFtMime(env.contentType)) {
        probes++
        binding = await ftBindingFromLineage(
          cand.txid,
          cand.vout,
          wallet.chain,
          1,
          new Set(),
        )
      }
    } else {
      probes++
      binding = await ftBindingFromLineage(
        cand.txid,
        cand.vout,
        wallet.chain,
        LINEAGE_DEPTH,
        new Set(),
      )
    }
    if (!binding && fromCi?.origin) {
      binding = {
        origin: fromCi.origin,
        amt: fromCi.amt ?? 1,
        sym: fromCi.sym ?? 'Token',
        supply: 'open',
        maxSupply: null,
      }
    }
    if (!binding) continue
    if (fromCi?.amt != null) binding = { ...binding, amt: fromCi.amt }
    if (fromCi?.sym) binding = { ...binding, sym: fromCi.sym }

    try {
      await wallet.wallet.relinquishOutput({
        basket: '1sat',
        output: cand.outpoint,
      })
      forgetOneSatImported([cand.outpoint])

      const atomic = await getAtomicBeefBinaryForTxid(wallet, cand.txid)
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
    } catch (err) {
      result.failed++
      console.warn('[1sat-ft-reclaim] move failed', cand.outpoint, err)
    }
  }

  if (dropOps.length > 0 || moveOps.length > 0) {
    scheduleHistoryBackupPush('reclaimMisfiledOnesatFt')
    void listColourTokens(wallet).catch(() => {})
    try {
      const { listCollectables, invalidateLiveOneSatOutpoints } =
        await import('./collectables')
      invalidateLiveOneSatOutpoints()
      void listCollectables(wallet).catch(() => {})
    } catch {
      /* ignore */
    }
    console.info(
      `[1sat-ft-reclaim] dropped ${result.droppedDuplicates} NFT duplicate(s), moved ${result.moved} tip(s) to 1sat-ft` +
        (result.failed ? `, failed ${result.failed}` : ''),
    )
  }

  return result
}
