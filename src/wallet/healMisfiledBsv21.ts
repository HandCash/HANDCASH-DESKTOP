/**
 * Heal BSV-21 fungibles that Refresh/import painted into basket `1sat` (NFT).
 * Local basket move only — no broadcast.
 *
 * Real 1sat collectables (image/text inscriptions, ordinal remittance without
 * a valid bsv-20 payload) stay in `1sat`. 1sat-ft stays for the FT reclaim.
 */
import {
  BSV21_BASKET,
  buildBsv21CustomInstructions,
  bsv21Tags,
  isBsv21Mime,
  parseBsv21Json,
  tokenIdForPayload,
  tokenIdFromBsv21Tags,
  type Bsv21Op,
  type Bsv21Payload,
} from './bsv21'
import { getAtomicBeefBinaryForTxid } from './beefCache'
import { normalizeLockingScriptHex } from './collectableTipKind'
import { isOnesatFtMime } from './colourCoins'
import { scheduleHistoryBackupPush } from './deviceSync'
import { stampBrc164Id } from './itemAccess'
import { wireCollectableOutpoint } from './oneSatCollectableGuard'
import { parseOrdEnvelope } from './ordinalOwnership'
import { getActiveWallet, type ActiveWallet } from './session'

export type OneSatAsBsv21 =
  | { kind: 'bsv21'; payload: Bsv21Payload; tokenId: string }
  | { kind: 'skip' }

export type ClassifyOneSatAsBsv21Args = {
  satoshis: number
  outpoint?: string
  lockingScriptHex?: string
  customInstructions?: unknown
  tags?: string[]
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

function payloadFromEnvelope(
  lockingScriptHex: string | undefined,
): { mime: string; payload: Bsv21Payload | null } {
  const env = parseOrdEnvelope(lockingScriptHex)
  const mime = (env?.contentType ?? '').toLowerCase().split(';')[0]!.trim()
  if (!env?.body?.length) return { mime, payload: null }
  try {
    const json = JSON.parse(new TextDecoder().decode(env.body)) as unknown
    return { mime, payload: parseBsv21Json(json) }
  } catch {
    return { mime, payload: null }
  }
}

function collectableMime(mime: string): boolean {
  return (
    mime.startsWith('image/') ||
    mime.startsWith('text/') ||
    mime.includes('html') ||
    mime.startsWith('application/json') === false &&
      mime.length > 0 &&
      !isBsv21Mime(mime) &&
      !isOnesatFtMime(mime)
  )
}

/**
 * A 1sat-basket tip is a BSV-21 fungible only when the inscription or
 * remittance is a valid bsv-20 holding. Image/text collectables never move.
 */
export function classifyOneSatAsBsv21(
  args: ClassifyOneSatAsBsv21Args,
): OneSatAsBsv21 {
  if (args.satoshis !== 1) return { kind: 'skip' }

  const { mime, payload: envPayload } = payloadFromEnvelope(args.lockingScriptHex)
  if (mime && isOnesatFtMime(mime)) return { kind: 'skip' }

  const ci = asRecord(args.customInstructions)
  const ciProtocol = String(ci?.p ?? '').toLowerCase()
  if (ciProtocol === '1sat-ft') return { kind: 'skip' }

  // Image / text / other collectable envelopes stay NFTs even if someone
  // stamped a token remittance on top (Pixel Foxes ≠ FOX).
  if (mime && !isBsv21Mime(mime) && collectableMime(mime)) {
    return { kind: 'skip' }
  }

  const ciPayload = parseBsv21Json(ci)
  const payload = envPayload ?? ciPayload
  const op = (payload?.op ?? tagValue(args.tags, 'op:') ?? 'transfer') as Bsv21Op
  const tokenId =
    (payload ? tokenIdForPayload(payload, args.outpoint ?? '') : null) ??
    tokenIdFromBsv21Tags(args.tags)
  const amt = payload?.amt ?? tagValue(args.tags, 'amt:')
  const hasBsv21Tag = (args.tags ?? []).some(
    (t) => t === 'bsv21' || t.toLowerCase().startsWith('bsv21:'),
  )

  if (payload && tokenId) {
    return { kind: 'bsv21', payload, tokenId }
  }
  if ((isBsv21Mime(mime) || hasBsv21Tag) && tokenId && amt) {
    const built = parseBsv21Json({
      p: 'bsv-20',
      op,
      id: tokenId,
      amt,
      ...(payload?.sym || tagValue(args.tags, 'sym:')
        ? { sym: payload?.sym ?? tagValue(args.tags, 'sym:') }
        : {}),
    })
    if (built) {
      return {
        kind: 'bsv21',
        payload: built,
        tokenId: tokenIdForPayload(built, args.outpoint ?? '') ?? tokenId,
      }
    }
  }
  return { kind: 'skip' }
}

export type HealMisfiledBsv21Result = {
  droppedDuplicates: number
  moved: number
  skipped: number
  failed: number
}

/**
 * Relinquish misfiled BSV-21 tips from basket `1sat` and re-insert under
 * `bsv21`. Duplicate rows already in `bsv21` are dropped from `1sat` only.
 */
export async function healMisfiledBsv21(
  active?: ActiveWallet | null,
): Promise<HealMisfiledBsv21Result> {
  const wallet = active ?? getActiveWallet()
  const result: HealMisfiledBsv21Result = {
    droppedDuplicates: 0,
    moved: 0,
    skipped: 0,
    failed: 0,
  }
  if (!wallet) return result

  const [itemListed, tokenListed] = await Promise.all([
    wallet.wallet.listOutputs({
      basket: '1sat',
      limit: 2000,
      includeTags: true,
      include: 'locking scripts',
      seekPermission: false,
    }),
    wallet.wallet.listOutputs({
      basket: BSV21_BASKET,
      limit: 2000,
      seekPermission: false,
    }),
  ])

  const tokenOps = new Set(
    (tokenListed.outputs ?? []).map((o) => wireCollectableOutpoint(o.outpoint)),
  )

  type Cand = {
    outpoint: string
    txid: string
    vout: number
    payload: Bsv21Payload
    tokenId: string
  }
  const drop: string[] = []
  const move: Cand[] = []

  for (const row of itemListed.outputs ?? []) {
    const op = wireCollectableOutpoint(row.outpoint)
    const sats =
      typeof row.satoshis === 'number'
        ? row.satoshis
        : Number((row as { satoshis?: unknown }).satoshis)
    if (!op || sats !== 1) continue
    const scriptHex = normalizeLockingScriptHex(
      (row as { lockingScript?: unknown }).lockingScript,
    )
    const kind = classifyOneSatAsBsv21({
      satoshis: 1,
      outpoint: op,
      lockingScriptHex: scriptHex || undefined,
      customInstructions: (row as { customInstructions?: unknown }).customInstructions,
      tags: row.tags,
    })
    if (kind.kind !== 'bsv21') {
      result.skipped++
      continue
    }
    const [txid, vOut] = op.split('.')
    const vout = Number(vOut)
    if (!txid || !Number.isInteger(vout)) continue
    if (tokenOps.has(op)) drop.push(op)
    else {
      move.push({
        outpoint: op,
        txid,
        vout,
        payload: kind.payload,
        tokenId: kind.tokenId,
      })
    }
  }

  for (const op of drop) {
    try {
      await wallet.wallet.relinquishOutput({ basket: '1sat', output: op })
      result.droppedDuplicates++
    } catch (err) {
      result.failed++
      console.warn('[bsv21-heal] drop NFT duplicate failed', op, err)
    }
  }

  for (const cand of move) {
    try {
      await wallet.wallet.relinquishOutput({
        basket: '1sat',
        output: cand.outpoint,
      })
      const atomic = await getAtomicBeefBinaryForTxid(wallet, cand.txid)
      const amt = cand.payload.amt ?? '0'
      const op = cand.payload.op
      await wallet.wallet.internalizeAction({
        tx: atomic,
        description: 'Heal BSV-21 token'.slice(0, 50),
        labels: [BSV21_BASKET, 'handcash-bsv21-heal'],
        outputs: [
          {
            outputIndex: cand.vout,
            protocol: 'basket insertion',
            insertionRemittance: {
              basket: BSV21_BASKET,
              tags: stampBrc164Id(
                bsv21Tags({
                  tokenId: cand.tokenId,
                  amt,
                  sym: cand.payload.sym,
                  op,
                }),
              ),
              customInstructions: buildBsv21CustomInstructions({
                tokenId: cand.tokenId,
                amt,
                op,
                sym: cand.payload.sym,
                icon: cand.payload.icon,
                dec: cand.payload.dec,
              }),
            },
          },
        ],
        seekPermission: false,
      })
      result.moved++
    } catch (err) {
      result.failed++
      console.warn('[bsv21-heal] move failed', cand.outpoint, err)
    }
  }

  if (result.droppedDuplicates > 0 || result.moved > 0) {
    scheduleHistoryBackupPush('healMisfiledBsv21')
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
      `[bsv21-heal] dropped ${result.droppedDuplicates} NFT duplicate(s), moved ${result.moved} tip(s) to bsv21` +
        (result.failed ? `, failed ${result.failed}` : ''),
    )
  }

  return result
}
