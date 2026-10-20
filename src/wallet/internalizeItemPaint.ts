/**
 * Paint collectables after BRC-100 `internalizeAction` from a connected app.
 *
 * Messagebox ingest (`ingestItemSettle`) already seeds cards; the bridge path
 * went straight to `wallet.internalizeAction` and left Collect empty until a
 * slow `listOutputs` caught up — or forever if the basket read raced a spend lock.
 */
import { Beef, Transaction } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import { extractTxid } from './txExplorer'
import {
  isItemBasket,
  isItemIssuanceArgs,
  isItemReceiveArgs,
} from './itemAccess'
import { isTokenScript, scriptPaysAddress } from './ordinalOwnership'
import { looksLikeRetiredFungibleTip } from './retiredFungible'
import {
  hasSettledActivityItemOutpoint,
  upsertAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import { announceItemsReceived } from './itemArrivalToast'
import { contentUrlForOrigin } from './oneSatImport'
import { rememberResolvedInscription } from './inscriptionCache'
import { rememberItemArtFromScript, getItemArtDataUrl } from './localItemArt'
import { proveHeldOutputFromBeef } from './oneSatProvenance'
import { clearAwaitingVerification } from './verificationProgress'

export type InternalizedItemTip = {
  outpoint: string
  origin?: string
  name?: string
  app?: string
  collectionId?: string
  imageUrl?: string
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
  collectionId?: string
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
    const collectionId =
      typeof parsed.collectionId === 'string' && parsed.collectionId.trim()
        ? parsed.collectionId.trim()
        : undefined
    return { origin, name, app, collectionId }
  } catch {
    return {}
  }
}

/** Rows that carry a token amount are tokens, never items. */
function carriesTokenAmount(tags: unknown[], customInstructions: unknown): boolean {
  if (tags.some((t) => typeof t === 'string' && /^amt:/i.test(t))) return true
  if (typeof customInstructions !== 'string') return false
  try {
    const amt = asRecord(JSON.parse(customInstructions))?.amt
    return typeof amt === 'string' || typeof amt === 'number'
  } catch {
    return false
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
    const tags = Array.isArray(rem.tags) ? rem.tags : []
    if (
      looksLikeRetiredFungibleTip({
        tags,
        customInstructions: rem.customInstructions,
      })
    ) {
      continue
    }
    if (carriesTokenAmount(tags, rem.customInstructions)) continue
    const outputIndex =
      typeof out.outputIndex === 'number' && Number.isInteger(out.outputIndex)
        ? out.outputIndex
        : typeof out.outputIndex === 'string' && /^\d+$/.test(out.outputIndex)
          ? Number.parseInt(out.outputIndex, 10)
          : -1
    if (outputIndex < 0) continue
    const outpoint = `${txid}.${outputIndex}`
    const fromTags = {
      origin: tagValue(tags, 'origin:'),
      name: tagValue(tags, 'name:'),
      app: tagValue(tags, 'app:'),
      collectionId: tagValue(tags, 'collection:'),
    }
    const fromCustom = parseCustomInstructions(rem.customInstructions)
    tips.push({
      outpoint,
      origin: fromCustom.origin ?? fromTags.origin ?? undefined,
      name: fromCustom.name ?? fromTags.name ?? undefined,
      app: fromCustom.app ?? fromTags.app ?? undefined,
      collectionId: fromCustom.collectionId ?? fromTags.collectionId ?? undefined,
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
      if (isTokenScript(hex) || looksLikeRetiredFungibleTip({ lockingScriptHex: hex })) continue
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

/** The signed package a createAction returned (or was handed), as a Beef. */
function beefFromCreateAction(result: unknown, args: unknown): Beef | null {
  const candidates = [
    result && typeof result === 'object' ? (result as { tx?: unknown }).tx : undefined,
    asRecord(args)?.tx,
  ]
  for (const raw of candidates) {
    let binary: number[] | null = null
    if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
      binary = raw as number[]
    } else if (raw instanceof Uint8Array) {
      binary = Array.from(raw)
    }
    if (!binary?.length) continue
    try {
      return Beef.fromBinary(binary)
    } catch {
      /* raw transaction bytes carry no lineage */
    }
  }
  return null
}

function lockingScriptsFromCreateAction(
  txid: string,
  args: unknown,
  result: unknown,
): Array<{ vout: number; satoshis: number; hex: string }> {
  const found: Array<{ vout: number; satoshis: number; hex: string }> = []
  const takeTx = (tx: { outputs?: Array<{ satoshis?: number; lockingScript?: { toHex?: () => string } }> }) => {
    const outputs = tx.outputs ?? []
    outputs.forEach((out, vout) => {
      const hex = out?.lockingScript?.toHex?.()
      if (!hex) return
      found.push({ vout, satoshis: Number(out.satoshis ?? 0), hex })
    })
  }
  const tryBinary = (raw: unknown): boolean => {
    let binary: number[] | null = null
    if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
      binary = raw as number[]
    } else if (raw instanceof Uint8Array) {
      binary = Array.from(raw)
    }
    if (!binary?.length) return false
    try {
      const beef = Beef.fromBinary(binary)
      const tx = beef.findTxid(txid)?.tx ?? beef.findAtomicTransaction(txid)
      if (tx?.outputs?.length) {
        takeTx(tx)
        return true
      }
    } catch {
      /* not AtomicBEEF */
    }
    try {
      takeTx(Transaction.fromBinary(binary))
      return found.length > 0
    } catch {
      return false
    }
  }
  if (result && typeof result === 'object') {
    if (tryBinary((result as { tx?: unknown }).tx)) return found
  }
  const body = asRecord(args)
  if (tryBinary(body?.tx)) return found
  const outputs = Array.isArray(body?.outputs) ? body!.outputs : []
  outputs.forEach((raw, vout) => {
    const out = asRecord(raw)
    if (!out || typeof out.lockingScript !== 'string' || !out.lockingScript) return
    found.push({
      vout,
      satoshis: Number(out.satoshis ?? 0),
      hex: out.lockingScript,
    })
  })
  return found
}

/** Seed Collect + Activity after a successful app `internalizeAction` for items. */
export function paintAfterInternalizeItem(
  active: ActiveWallet,
  originator: string,
  args: unknown,
  result: unknown,
): number {
  if (!isItemReceiveArgs('internalizeAction', args)) return 0
  const txid = extractTxid(result) ?? extractTxid(args)
  const scripts = txid ? lockingScriptsFromCreateAction(txid, args, result) : []
  const tokenOps = new Set(
    scripts
      .filter((s) => s.satoshis === 1 && isTokenScript(s.hex))
      .map((s) => `${txid}.${s.vout}`),
  )
  const tips = parseInternalizedItemTips(active, args, result).filter(
    (tip) => !tokenOps.has(tip.outpoint.trim().toLowerCase()),
  )
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
      ...(tip.collectionId ? { collectionId: tip.collectionId } : {}),
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
          app: tip.app,
          collectionId: tip.collectionId,
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

/**
 * Seed Collect after a mint-studio (or any app) `createAction` that
 * issues a fresh 1sat output. Without this, Collect stays on the last list
 * while auto heal holds the ingest lock — the tip is in the basket, never painted.
 */
export function paintAfterCreateActionIssuance(
  active: ActiveWallet,
  originator: string,
  args: unknown,
  result: unknown,
): number {
  if (!isItemIssuanceArgs('createAction', args)) return 0
  const txid = extractTxid(result) ?? extractTxid(args)
  if (!txid) return 0
  const scripts = lockingScriptsFromCreateAction(txid, args, result)
  const tokenOps = new Set(
    scripts
      .filter((s) => s.satoshis === 1 && isTokenScript(s.hex))
      .map((s) => `${txid}.${s.vout}`),
  )
  const itemTips: InternalizedItemTip[] = []
  for (const out of scripts) {
    if (out.satoshis !== 1) continue
    const op = `${txid}.${out.vout}`
    if (tokenOps.has(op)) continue
    if (!scriptPaysAddress(out.hex, active.address)) continue
    const origin = `${txid}_${out.vout}`
    // The mint we just signed carries its own art. Keep it now: the indexer has
    // never heard of this transaction, so `/content/` would 404 for as long as
    // it takes to be indexed and the card would paint the placeholder glyph.
    rememberItemArtFromScript(origin, out.hex)
    itemTips.push({
      outpoint: op,
      origin,
      name: issuanceNameFromArgs(args, out.vout) || 'Collectable',
      imageUrl: getItemArtDataUrl(origin),
    })
  }
  if (itemTips.length === 0) return 0

  // The package we just signed is the whole lineage of a fresh mint. Prove it
  // here, so the card is verified when it appears instead of waiting on an
  // indexer that has not seen the transaction.
  const signedBeef = beefFromCreateAction(result, args)
  let painted = 0
  for (const tip of itemTips) {
    const op = tip.outpoint
    const origin = tip.origin ?? op.replace(/\.(\d+)$/, '_$1')
    const name = tip.name?.trim() || 'Collectable'
    if (signedBeef) {
      try {
        if (proveHeldOutputFromBeef(signedBeef, op)) clearAwaitingVerification(op)
      } catch (err) {
        console.warn('[brc100] local lineage proof for issued item skipped', err)
      }
    }
    rememberResolvedInscription(op, {
      origin,
      name,
      traits: [],
      extras: [],
    })
    if (!hasSettledActivityItemOutpoint(op)) {
      upsertAppActivity({
        origin: originator || WALLET_ACTIVITY_ORIGIN,
        kind: 'earned',
        sats: 1,
        method: 'mint-collectable',
        note: `Minted ${name}`,
        txid,
        status: 'complete',
        item: {
          name,
          origin,
          outpoint: op,
          imageUrl:
            tip.imageUrl ||
            getItemArtDataUrl(origin) ||
            contentUrlForOrigin(origin, active.chain),
        },
      })
    }
    painted += 1
  }
  void import('./collectables')
    .then(({ noteIngestedItem, listCollectables }) => {
      for (const tip of itemTips) {
        noteIngestedItem({
          outpoint: tip.outpoint,
          chain: active.chain,
          origin: tip.origin,
          name: tip.name,
        })
      }
      announceItemsReceived(itemTips.map((t) => t.outpoint))
      return listCollectables(active)
    })
    .catch((err) => {
      console.warn('[brc100] post-createAction collectables paint failed', err)
      announceItemsReceived(itemTips.map((t) => t.outpoint))
    })
  console.info(
    `[brc100] painted ${itemTips.length} issued collectable(s) after createAction`,
  )
  return painted
}

function issuanceNameFromArgs(
  args: unknown,
  vout: number,
): string | undefined {
  const body = asRecord(args)
  const outputs = Array.isArray(body?.outputs) ? body.outputs : []
  const out = asRecord(outputs[vout])
  if (!out || Number(out.satoshis) !== 1 || !isItemBasket(out.basket)) {
    return undefined
  }
  return (
    tagValue(out.tags, 'name:') ??
    parseCustomInstructions(out.customInstructions).name
  )
}
