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
  isBsv21Basket,
  isItemBasket,
  isItemIssuanceArgs,
  isItemReceiveArgs,
} from './itemAccess'
import {
  cacheTokenIconFromBeef,
  fungibleFromImport,
  hydrateCachedTokenIcons,
  looksLikeOnesatFtTip,
  normalizeTokenId,
  originFromOnesatFtLock,
  parseBsv21CustomInstructions,
  rememberFungibleToken,
  shortTokenLabel,
  tokenIdFromBsv21Tags,
} from './token'
import { parseOrdEnvelope, scriptPaysAddress } from './ordinalOwnership'
import {
  hasSettledActivityItemOutpoint,
  noteInboundReceiveComplete,
  upsertAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import { announceItemsReceived } from './itemArrivalToast'
import { contentUrlForOrigin } from './oneSatImport'
import { rememberResolvedInscription } from './inscriptionCache'
import {
  classifyOneSatAsBsv21,
  isFungibleOneSatLock,
} from './healMisfiledBsv21'

export type InternalizedItemTip = {
  outpoint: string
  origin?: string
  name?: string
  app?: string
  collectionId?: string
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
      tags.some(
        (t) =>
          typeof t === 'string' &&
          (/^bsv21/i.test(t) || /^amt:/i.test(t) || /^1sat-ft/i.test(t)),
      )
    ) {
      continue
    }
    const bsv21Ci = parseBsv21CustomInstructions(
      typeof rem.customInstructions === 'string' ? rem.customInstructions : undefined,
    )
    if (bsv21Ci?.id && bsv21Ci.amt) continue
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
      if (isFungibleOneSatLock(hex)) continue
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

function tokenSym(raw: string | undefined, tokenId: string): string {
  const s = raw?.trim()
  if (s && s !== 'Collectable' && s !== 'Token') return s
  return shortTokenLabel(tokenId)
}

function onesatFtAmtFromLock(hex: string): string | null {
  try {
    const env = parseOrdEnvelope(hex)
    if (!env?.body?.length) return null
    const json = JSON.parse(new TextDecoder().decode(env.body)) as { amt?: unknown }
    if (typeof json?.amt === 'string' && /^\d+$/.test(json.amt) && BigInt(json.amt) > 0n) {
      return json.amt
    }
    if (typeof json?.amt === 'number' && Number.isSafeInteger(json.amt) && json.amt > 0) {
      return String(json.amt)
    }
  } catch {
    /* ignore */
  }
  return null
}

function paintFungibleTip(opts: {
  active: ActiveWallet
  originator: string
  txid: string
  vout: number
  hex: string
  method: 'mint-token' | 'receive-token'
}): boolean {
  const outpoint = `${opts.txid}.${opts.vout}`
  const classified = classifyOneSatAsBsv21({
    satoshis: 1,
    outpoint,
    lockingScriptHex: opts.hex,
  })
  let tokenId: string | null = null
  let amt: string | null = null
  let sym: string | undefined
  let dec = 0
  if (classified.kind === 'bsv21') {
    tokenId = classified.tokenId
    amt = classified.payload.amt ?? null
    sym = classified.payload.sym
    dec = classified.payload.dec ?? 0
  } else if (looksLikeOnesatFtTip({ lockingScriptHex: opts.hex })) {
    tokenId =
      originFromOnesatFtLock(opts.hex) ??
      `${opts.txid}_${opts.vout}`
    amt = onesatFtAmtFromLock(opts.hex)
  }
  if (!tokenId || !amt || !/^\d+$/.test(amt) || BigInt(amt) <= 0n) return false
  const name = tokenSym(sym, tokenId)
  const token = fungibleFromImport({
    outpoint,
    txid: opts.txid,
    vout: opts.vout,
    tokenId,
    amt,
    op: classified.kind === 'bsv21' ? classified.payload.op : 'transfer',
    sym: name,
    dec,
  })
  rememberFungibleToken(token)
  void hydrateCachedTokenIcons(opts.active, [token]).catch(() => {})
  if (opts.method === 'mint-token') {
    upsertAppActivity({
      origin: opts.originator || WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'mint-token',
      note: `Minted ${amt} ${name}`,
      txid: opts.txid,
      item: {
        name,
        origin: tokenId,
        outpoint,
        tokenId,
        amt,
        dec,
      },
    })
  } else {
    noteInboundReceiveComplete({
      txid: opts.txid,
      item: true,
      itemName: name,
      itemOrigin: tokenId,
      outpoint,
      token: { tokenId, amount: amt, sym: name, dec },
    })
  }
  return true
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

function paintFungiblesFromScripts(
  active: ActiveWallet,
  originator: string,
  txid: string,
  scripts: Array<{ vout: number; satoshis: number; hex: string }>,
  method: 'mint-token' | 'receive-token',
): number {
  let painted = 0
  for (const out of scripts) {
    if (out.satoshis !== 1) continue
    if (!scriptPaysAddress(out.hex, active.address)) continue
    if (!isFungibleOneSatLock(out.hex)) continue
    if (paintFungibleTip({ active, originator, txid, vout: out.vout, hex: out.hex, method })) {
      painted += 1
    }
  }
  return painted
}

/** Seed Tokens immediately after an app inserts a BSV-21 basket output. */
export function paintAfterInternalizeBsv21(
  active: ActiveWallet,
  args: unknown,
  result: unknown,
): number {
  const txid = extractTxid(result) ?? extractTxid(args)
  const body = asRecord(args)
  const outputs = Array.isArray(body?.outputs) ? body.outputs : []
  if (!txid || outputs.length === 0) return 0

  const atomic = Array.isArray(body?.tx) ? (body.tx as number[]) : null
  let beef: Beef | null = null
  if (atomic?.length) {
    try {
      beef = Beef.fromBinary(atomic)
    } catch {
      // The wallet already validated the transaction; metadata remains usable.
    }
  }

  let painted = 0
  for (const raw of outputs) {
    const out = asRecord(raw)
    if (!out || out.protocol !== 'basket insertion') continue
    const rem = asRecord(out.insertionRemittance)
    if (!rem || !isBsv21Basket(rem.basket)) continue
    const outputIndex = Number(out.outputIndex)
    if (!Number.isInteger(outputIndex) || outputIndex < 0) continue
    const tags = Array.isArray(rem.tags)
      ? rem.tags.filter((tag): tag is string => typeof tag === 'string')
      : []
    const ci = parseBsv21CustomInstructions(
      typeof rem.customInstructions === 'string'
        ? rem.customInstructions
        : undefined,
    )
    const tokenId =
      normalizeTokenId(ci?.id ?? '') ?? tokenIdFromBsv21Tags(tags)
    const amount = ci?.amt ?? tagValue(tags, 'amt:')
    if (!tokenId || !amount || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
      continue
    }
    const sym = ci?.sym ?? tagValue(tags, 'sym:') ?? shortTokenLabel(tokenId)
    const icon =
      normalizeTokenId(ci?.icon ?? '') ??
      normalizeTokenId(tagValue(tags, 'icon:') ?? '') ??
      undefined
    const issuer = ci?.issuer ?? tagValue(tags, 'issuer:') ?? undefined
    if (icon && beef) cacheTokenIconFromBeef(icon, beef)
    const token = fungibleFromImport({
      outpoint: `${txid}.${outputIndex}`,
      txid,
      vout: outputIndex,
      tokenId,
      amt: amount,
      op: 'transfer',
      sym,
      icon,
      dec: ci?.dec ?? 0,
      issuer,
    })
    rememberFungibleToken(token)
    void hydrateCachedTokenIcons(active, [token]).catch(() => {})
    painted += 1
  }
  if (painted > 0) {
    console.info(`[brc100] painted ${painted} BSV-21 tip(s) after internalizeAction`)
  }
  return painted
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
  const tokenPainted = txid
    ? paintFungiblesFromScripts(active, originator, txid, scripts, 'receive-token')
    : 0
  const tokenOps = new Set(
    scripts
      .filter((s) => s.satoshis === 1 && isFungibleOneSatLock(s.hex))
      .map((s) => `${txid}.${s.vout}`),
  )
  const tips = parseInternalizedItemTips(active, args, result).filter(
    (tip) => !tokenOps.has(tip.outpoint.trim().toLowerCase()),
  )
  if (tips.length === 0) return tokenPainted

  let painted = tokenPainted
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
 * Seed Collect / Tokens after a mint-studio (or any app) `createAction` that
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
  const tokenPainted = paintFungiblesFromScripts(
    active,
    originator || WALLET_ACTIVITY_ORIGIN,
    txid,
    scripts,
    'mint-token',
  )
  const tokenOps = new Set(
    scripts
      .filter((s) => s.satoshis === 1 && isFungibleOneSatLock(s.hex))
      .map((s) => `${txid}.${s.vout}`),
  )
  const itemTips: InternalizedItemTip[] = []
  for (const out of scripts) {
    if (out.satoshis !== 1) continue
    const op = `${txid}.${out.vout}`
    if (tokenOps.has(op)) continue
    if (!scriptPaysAddress(out.hex, active.address)) continue
    itemTips.push({
      outpoint: op,
      origin: `${txid}_${out.vout}`,
      name: issuanceNameFromArgs(args) || 'Collectable',
    })
  }
  if (itemTips.length === 0) return tokenPainted

  let painted = tokenPainted
  for (const tip of itemTips) {
    const op = tip.outpoint
    const origin = tip.origin ?? op.replace(/\.(\d+)$/, '_$1')
    const name = tip.name?.trim() || 'Collectable'
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
        method: 'receive-collectable',
        note: `Received ${name}`,
        txid,
        status: 'complete',
        item: {
          name,
          origin,
          outpoint: op,
          imageUrl: contentUrlForOrigin(origin, active.chain),
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

function issuanceNameFromArgs(args: unknown): string | undefined {
  const body = asRecord(args)
  const outputs = Array.isArray(body?.outputs) ? body.outputs : []
  for (const raw of outputs) {
    const out = asRecord(raw)
    if (!out || Number(out.satoshis) !== 1 || !isItemBasket(out.basket)) continue
    const name = tagValue(out.tags, 'name:')
    if (name) return name
    const fromCustom = parseCustomInstructions(out.customInstructions)
    if (fromCustom.name) return fromCustom.name
  }
  return undefined
}
