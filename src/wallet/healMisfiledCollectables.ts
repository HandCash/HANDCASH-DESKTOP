/**
 * Heal 1sat collectables that Refresh/import painted into basket `bsv21`
 * (Collect → Tokens / NFT). Local basket move only — no broadcast.
 *
 * Real BSV-21 (application/bsv-20 + valid JSON) and 1sat-ft stay put.
 */
import { isBsv21Mime, parseBsv21Json } from './bsv21'
import { getAtomicBeefBinaryForTxid } from './beefCache'
import { BSV21_BASKET } from './bsv21'
import { isOnesatFtMime } from './colourCoins'
import { scheduleHistoryBackupPush } from './deviceSync'
import { stampBrc164Id } from './itemAccess'
import { markOneSatImported } from './oneSatImportGuard'
import { buildInternalizeCustomInstructions } from './oneSatProvenance'
import { normalizeLockingScriptHex } from './collectableTipKind'
import { parseOrdEnvelope } from './ordinalOwnership'
import { getActiveWallet, type ActiveWallet } from './session'
import {
  applyCollectableRemittance,
  wireCollectableOutpoint,
  type CollectableRemittance,
} from './oneSatCollectableGuard'

export type TokenBasketTipClass = 'collectable' | 'token' | 'unknown'

export type ClassifyTokenBasketTipArgs = {
  satoshis: number
  lockingScriptHex?: string
  customInstructions?: unknown
  tags?: string[]
  cached?: CollectableRemittance | null
  importedOneSat?: boolean
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const o = JSON.parse(raw) as unknown
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        return o as Record<string, unknown>
      }
    } catch {
      return null
    }
  }
  return null
}

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  const hit = tags.find((t) => t.toLowerCase().startsWith(prefix.toLowerCase()))
  if (!hit) return undefined
  const value = hit.slice(prefix.length).trim()
  return value || undefined
}

export function classifyTokenBasketTip(
  args: ClassifyTokenBasketTipArgs,
): TokenBasketTipClass {
  if (args.satoshis !== 1) return 'unknown'

  const env = parseOrdEnvelope(args.lockingScriptHex)
  const mime = (env?.contentType ?? '').toLowerCase().split(';')[0]!.trim()
  const ci = asRecord(args.customInstructions)
  const ciProtocol = String(ci?.p ?? '').toLowerCase()
  const bsv21Ci = parseBsv21Json(ci)
  const cached = args.cached
  const cachedCollectable = Boolean(
    cached?.origin ||
      (cached?.name && cached.name.trim() && cached.name.trim() !== 'Collectable'),
  )
  const originTag = tagValue(args.tags, 'origin:')
  const nameTag = tagValue(args.tags, 'name:')
  const hasOrdinalTag = (args.tags ?? []).some((t) => t.toLowerCase() === 'ordinal')
  const knownItem =
    cachedCollectable ||
    Boolean(args.importedOneSat && (originTag || cached?.origin || ci?.origin))

  if (mime && isOnesatFtMime(mime)) return 'token'
  if (ciProtocol === '1sat-ft') return 'token'

  if (mime && isBsv21Mime(mime)) {
    let body: unknown
    if (env?.body?.length) {
      try {
        body = JSON.parse(new TextDecoder().decode(env.body))
      } catch {
        body = null
      }
    }
    if (parseBsv21Json(body)) return 'token'
    // Indexer stamped bsv-20 mime on a non-token body (Pixel Foxes).
    return knownItem || hasOrdinalTag || Boolean(originTag) ? 'collectable' : 'token'
  }

  if (mime.startsWith('image/') || mime.startsWith('text/') || mime.includes('html')) {
    return 'collectable'
  }
  if (env && mime && !isBsv21Mime(mime) && !isOnesatFtMime(mime)) {
    return 'collectable'
  }

  if (bsv21Ci) {
    // Valid BSV-21 remittance. Only override when this outpoint is already a
    // named collectable (the Refresh misfile wrote token CI over an item).
    return knownItem ? 'collectable' : 'token'
  }

  if (typeof ci?.origin === 'string' && ci.origin.trim() && ciProtocol !== 'bsv-20') {
    return 'collectable'
  }
  if (hasOrdinalTag && (originTag || nameTag || knownItem)) return 'collectable'
  if (knownItem) return 'collectable'
  return 'unknown'
}

export type HealMisfiledCollectablesResult = {
  droppedDuplicates: number
  moved: number
  skippedTokens: number
  failed: number
}

function remittanceFromRow(
  op: string,
  tags: string[] | undefined,
  ci: unknown,
  cached: CollectableRemittance | undefined,
): CollectableRemittance {
  const rec = asRecord(ci)
  const origin =
    cached?.origin ||
    tagValue(tags, 'origin:') ||
    (typeof rec?.origin === 'string' ? rec.origin : undefined) ||
    op.replace(/\.(\d+)$/, '_$1')
  const name =
    cached?.name ||
    tagValue(tags, 'name:') ||
    (typeof rec?.name === 'string' ? rec.name : undefined) ||
    'Collectable'
  const app =
    cached?.app ||
    tagValue(tags, 'app:') ||
    (typeof rec?.app === 'string' ? rec.app : undefined)
  const collectionId =
    cached?.collectionId ||
    tagValue(tags, 'collection:') ||
    (typeof rec?.collectionId === 'string' ? rec.collectionId : undefined)
  return applyCollectableRemittance(
    { outpoint: op, origin, name, app, collectionId },
    cached,
  )
}

async function loadCachedByOutpoint(): Promise<Map<string, CollectableRemittance>> {
  const map = new Map<string, CollectableRemittance>()
  try {
    const { getCachedCollectables } = await import('./collectables')
    for (const item of getCachedCollectables()) {
      const op = wireCollectableOutpoint(item.outpoint)
      if (!op) continue
      map.set(op, {
        outpoint: op,
        origin: item.origin,
        name: item.name,
        app: item.app,
        collectionId: item.collectionId,
      })
    }
  } catch {
    /* cache optional */
  }
  return map
}

/**
 * Relinquish misfiled collectables from `bsv21` and re-insert under basket
 * `1sat`. Duplicate rows already in `1sat` are dropped only.
 */
export async function healMisfiledCollectables(
  active?: ActiveWallet | null,
): Promise<HealMisfiledCollectablesResult> {
  const wallet = active ?? getActiveWallet()
  const result: HealMisfiledCollectablesResult = {
    droppedDuplicates: 0,
    moved: 0,
    skippedTokens: 0,
    failed: 0,
  }
  if (!wallet) return result

  const [bsv21Listed, itemListed] = await Promise.all([
    wallet.wallet.listOutputs({
      basket: BSV21_BASKET,
      limit: 2000,
      includeTags: true,
      includeCustomInstructions: true,
      include: 'locking scripts',
      seekPermission: false,
    }),
    wallet.wallet.listOutputs({
      basket: '1sat',
      limit: 2000,
      seekPermission: false,
    }),
  ])

  const itemOps = new Set(
    (itemListed.outputs ?? []).map((o) => wireCollectableOutpoint(o.outpoint)),
  )
  const cached = await loadCachedByOutpoint()
  const { isOneSatOutpointKnown } = await import('./oneSatImportGuard')

  type Cand = {
    basket: string
    outpoint: string
    txid: string
    vout: number
    tags?: string[]
    ci: unknown
  }
  const drop: Cand[] = []
  const move: Cand[] = []

  const consider = (
    basket: string,
    rows: Array<{
      outpoint: string
      satoshis?: number
      tags?: string[]
      customInstructions?: unknown
      lockingScript?: unknown
    }>,
  ) => {
    for (const row of rows) {
      const op = wireCollectableOutpoint(row.outpoint)
      const sats =
        typeof row.satoshis === 'number'
          ? row.satoshis
          : Number((row as { satoshis?: unknown }).satoshis)
      if (!op || sats !== 1) continue
      const scriptHex =
        normalizeLockingScriptHex(row.lockingScript) || undefined
      const kind = classifyTokenBasketTip({
        satoshis: 1,
        lockingScriptHex: scriptHex,
        customInstructions: row.customInstructions,
        tags: row.tags,
        cached: cached.get(op),
        importedOneSat: isOneSatOutpointKnown(op),
      })
      if (kind === 'token') {
        result.skippedTokens++
        continue
      }
      if (kind !== 'collectable') continue
      const [txid, vOut] = op.split('.')
      const vout = Number(vOut)
      if (!txid || !Number.isInteger(vout)) continue
      const cand: Cand = {
        basket,
        outpoint: op,
        txid,
        vout,
        tags: row.tags,
        ci: row.customInstructions,
      }
      if (itemOps.has(op)) drop.push(cand)
      else move.push(cand)
    }
  }

  consider(BSV21_BASKET, bsv21Listed.outputs ?? [])

  for (const cand of drop) {
    try {
      await wallet.wallet.relinquishOutput({
        basket: cand.basket,
        output: cand.outpoint,
      })
      result.droppedDuplicates++
    } catch (err) {
      result.failed++
      console.warn('[collectable-heal] drop duplicate failed', cand.outpoint, err)
    }
  }

  for (const cand of move) {
    const rem = remittanceFromRow(cand.outpoint, cand.tags, cand.ci, cached.get(cand.outpoint))
    try {
      await wallet.wallet.relinquishOutput({
        basket: cand.basket,
        output: cand.outpoint,
      })
      const atomic = await getAtomicBeefBinaryForTxid(wallet, cand.txid)
      const origin = rem.origin ?? cand.outpoint.replace(/\.(\d+)$/, '_$1')
      await wallet.wallet.internalizeAction({
        tx: atomic,
        description: 'Heal collectable'.slice(0, 50),
        labels: ['1sat', 'handcash-collectable-heal'],
        outputs: [
          {
            outputIndex: cand.vout,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: '1sat',
              tags: stampBrc164Id([
                'ordinal',
                `origin:${origin.replace(/_(\d+)$/, '.$1')}`,
                ...(rem.name ? [`name:${rem.name.slice(0, 80)}`] : []),
                ...(rem.app ? [`app:${rem.app.slice(0, 40)}`] : []),
                ...(rem.collectionId
                  ? [`collection:${rem.collectionId.slice(0, 80)}`]
                  : []),
              ]),
              customInstructions: buildInternalizeCustomInstructions({
                origin,
                name: rem.name ?? 'Collectable',
                app: rem.app,
                collectionId: rem.collectionId,
              }),
            },
          },
        ],
        seekPermission: false,
      })
      markOneSatImported([cand.outpoint])
      result.moved++
    } catch (err) {
      result.failed++
      console.warn('[collectable-heal] move failed', cand.outpoint, err)
    }
  }

  if (result.droppedDuplicates > 0 || result.moved > 0) {
    scheduleHistoryBackupPush('healMisfiledCollectables')
    try {
      const { listFungibles } = await import('./fungibles')
      void listFungibles(wallet).catch(() => {})
    } catch {
      /* optional */
    }
    try {
      const { listCollectables, invalidateLiveOneSatOutpoints } =
        await import('./collectables')
      invalidateLiveOneSatOutpoints()
      void listCollectables(wallet).catch(() => {})
    } catch {
      /* optional */
    }
    console.info(
      `[collectable-heal] dropped ${result.droppedDuplicates} NFT duplicate(s), moved ${result.moved} tip(s) to 1sat` +
        (result.skippedTokens ? `, left ${result.skippedTokens} token tip(s)` : '') +
        (result.failed ? `, failed ${result.failed}` : ''),
    )
  }

  return result
}
