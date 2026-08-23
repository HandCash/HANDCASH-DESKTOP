/**
 * Paint collectables after BRC-100 `internalizeAction` from a connected app.
 *
 * Messagebox ingest (`ingestItemSettle`) already seeds cards; the bridge path
 * went straight to `wallet.internalizeAction` and left Collect empty until a
 * slow `listOutputs` caught up — or forever if the basket read raced a spend lock.
 */
import { Beef } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { extractTxid } from './txExplorer'
import { isItemBasket, isItemReceiveArgs } from './itemAccess'
import { scriptPaysAddress } from './ordinalOwnership'
import {
  hasSettledActivityItemOutpoint,
  upsertAppActivity,
} from './appActivity'
import { announceItemsReceived } from './itemArrivalToast'
import { contentUrlForOrigin } from './oneSatImport'
import { rememberResolvedInscription } from './inscriptionCache'

export type InternalizedItemTip = {
  outpoint: string
  origin?: string
  name?: string
  app?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function tagValue(tags: unknown, prefix: string): string | null {
  if (!Array.isArray(tags)) return null
  for (const raw of tags) {
    if (typeof raw !== 'string' || !raw.startsWith(prefix)) continue
    return raw.slice(prefix.length).trim() || null
  }
  return null
}

function parseCustomInstructions(raw: unknown): {
  origin?: string
  name?: string
  app?: string
} {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const origin =
      typeof parsed.origin === 'string' && parsed.origin.trim()
        ? parsed.origin.trim()
        : undefined
    const name =
      typeof parsed.name === 'string' && parsed.name.trim()
        ? parsed.name.trim()
        : undefined
    const app =
      typeof parsed.app === 'string' && parsed.app.trim()
        ? parsed.app.trim()
        : undefined
    return { origin, name, app }
  } catch {
    return {}
  }
}

function tipsFromInsertionOutputs(
  txid: string,
  outputs: unknown[],
): InternalizedItemTip[] {
  const tips: InternalizedItemTip[] = []
  for (const raw of outputs) {
    const out = asRecord(raw)
    if (!out || out.protocol !== 'basket insertion') continue
    const rem = asRecord(out.insertionRemittance)
    if (!rem || !isItemBasket(rem.basket)) continue
    const outputIndex =
      typeof out.outputIndex === 'number' && Number.isInteger(out.outputIndex)
        ? out.outputIndex
        : typeof out.outputIndex === 'string' && /^\d+$/.test(out.outputIndex)
          ? Number.parseInt(out.outputIndex, 10)
          : -1
    if (outputIndex < 0) continue
    const outpoint = `${txid}.${outputIndex}`
    const tags = Array.isArray(rem.tags) ? rem.tags : []
    const fromTags = {
      origin: tagValue(tags, 'origin:'),
      name: tagValue(tags, 'name:'),
      app: tagValue(tags, 'app:'),
    }
    const fromCustom = parseCustomInstructions(rem.customInstructions)
    tips.push({
      outpoint,
      origin: fromCustom.origin ?? fromTags.origin ?? undefined,
      name: fromCustom.name ?? fromTags.name ?? undefined,
      app: fromCustom.app ?? fromTags.app ?? undefined,
    })
  }
  return tips
}

function tipsFromAtomicBeef(
  active: ActiveWallet,
  txid: string,
  atomic: number[],
): InternalizedItemTip[] {
  try {
    const beef = Beef.fromBinary(atomic)
    const tx = beef.findTxid(txid)?.tx ?? beef.findAtomicTransaction(txid)
    if (!tx) return []
    const tips: InternalizedItemTip[] = []
    const outputs = tx.outputs ?? []
    for (let i = 0; i < outputs.length; i++) {
      const out = outputs[i]
      const sats = out?.satoshis
      const hex = out?.lockingScript?.toHex()
      if (sats !== 1 || !hex || !scriptPaysAddress(hex, active.address)) continue
      tips.push({
        outpoint: `${txid}.${i}`,
        origin: `${txid}_${i}`,
        name: 'Collectable',
      })
    }
    return tips
  } catch {
    return []
  }
}

export function parseInternalizedItemTips(
  active: ActiveWallet,
  args: unknown,
  result: unknown,
): InternalizedItemTip[] {
  const txid = extractTxid(result) ?? extractTxid(args)
  if (!txid) return []

  const body = asRecord(args)
  const outputs = Array.isArray(body?.outputs) ? body!.outputs : []
  const fromOutputs = tipsFromInsertionOutputs(txid, outputs)
  if (fromOutputs.length > 0) return fromOutputs

  const atomic = Array.isArray(body?.tx)
    ? (body!.tx as number[])
    : Array.isArray(result) && (result as unknown[]).every((x) => typeof x === 'number')
      ? (result as number[])
      : null
  if (atomic?.length) return tipsFromAtomicBeef(active, txid, atomic)
  return []
}

/** Seed Collect + Activity after a successful app `internalizeAction` for items. */
export function paintAfterInternalizeItem(
  active: ActiveWallet,
  originator: string,
  args: unknown,
  result: unknown,
): number {
  if (!isItemReceiveArgs('internalizeAction', args)) return 0
  const tips = parseInternalizedItemTips(active, args, result)
  if (tips.length === 0) return 0

  let painted = 0
  for (const tip of tips) {
    const op = tip.outpoint.trim().toLowerCase()
    if (!op.includes('.')) continue
    const origin =
      tip.origin?.trim() ||
      op.replace(/\.(\d+)$/, '_$1')
    const name = tip.name?.trim() || 'Collectable'
    rememberResolvedInscription(op, {
      origin,
      name,
      ...(tip.app ? { app: tip.app } : {}),
      traits: [],
      extras: [],
    })
    if (!hasSettledActivityItemOutpoint(op)) {
      const receiveTxid = op.split('.')[0]
      upsertAppActivity({
        origin: originator,
        kind: 'earned',
        sats: 1,
        method: 'receive-collectable',
        note: `Received ${name}`,
        txid: receiveTxid || undefined,
        status: 'complete',
        item: {
          name,
          origin,
          outpoint: op,
          imageUrl: contentUrlForOrigin(origin, active.chain),
          ...(tip.app ? { app: tip.app } : {}),
        },
      })
    }
    painted += 1
  }

  void import('./collectables')
    .then(({ noteIngestedItem, listCollectables }) => {
      for (const tip of tips) {
        noteIngestedItem({
          outpoint: tip.outpoint,
          chain: active.chain,
          origin: tip.origin,
          name: tip.name,
        })
      }
      announceItemsReceived(tips.map((t) => t.outpoint))
      return listCollectables(active)
    })
    .catch((err) => {
      console.warn('[brc100] post-internalize collectables paint failed', err)
      announceItemsReceived(tips.map((t) => t.outpoint))
    })

  console.info(
    `[brc100] painted ${painted} collectable tip(s) after internalizeAction`,
  )
  return painted
}
