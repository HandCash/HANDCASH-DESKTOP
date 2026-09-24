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
  isBsv21IdentityMintArgs,
  normalizeTokenId,
  parseBsv21CustomInstructions,
  rememberFungibleToken,
  shortTokenLabel,
  tokenIdFromBsv21Tags,
} from './token'
import { scriptPaysAddress } from './ordinalOwnership'
import { looksLikeRetiredFungibleTip } from './retiredFungible'
import {
  hasSettledActivityItemOutpoint,
  noteInboundReceiveComplete,
  upsertAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from './appActivity'
import { announceItemsReceived } from './itemArrivalToast'
import { contentUrlForOrigin } from './oneSatImport'
import { rememberResolvedInscription } from './inscriptionCache'
import { rememberItemArtFromScript } from './localItemArt'
import {
  classifyOneSatAsBsv21,
  isBsv21OneSatLock,
  isNonCollectableOneSatLock,
  type OneSatAsBsv21,
} from './healMisfiledBsv21'

/**
 * Carry the wire format only when the locking script proved it. Remittance-only
 * evidence (`unproven`) leaves the card unclassified so the live basket read
 * names it, instead of pinning a fresh BRC-162 mint as burn-only legacy.
 */
function bsv21EncodingOf(
  classified: OneSatAsBsv21,
): { encoding?: 'brc162' | 'legacy-json' } {
  if (classified.kind !== 'bsv21') return {}
  if (classified.encoding === 'binary') return { encoding: 'brc162' }
  if (classified.encoding === 'json') return { encoding: 'legacy-json' }
  return {}
}

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
      looksLikeRetiredFungibleTip({
        tags,
        customInstructions: rem.customInstructions,
      })
    ) {
      continue
    }
    if (
      tags.some(
        (t) =>
          typeof t === 'string' &&
          (/^bsv21/i.test(t) || /^amt:/i.test(t)),
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
      if (isNonCollectableOneSatLock(hex)) continue
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
    ...(classified.kind === 'bsv21' && classified.encoding === 'binary'
      ? { binarySupply: 'locked' as const }
      : {}),
    ...bsv21EncodingOf(classified),
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
    if (!isBsv21OneSatLock(out.hex)) continue
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
    // Remittance tags are metadata; only the lock proves BRC-162. Read it from
    // the supplied BEEF so a binary tip is not painted as burn-only legacy.
    const lockHex = beef
      ? (beef.findTxid(txid)?.tx ?? beef.findAtomicTransaction(txid))?.outputs[
          outputIndex
        ]?.lockingScript?.toHex()
      : undefined
    const classified = classifyOneSatAsBsv21({
      satoshis: 1,
      outpoint: `${txid}.${outputIndex}`,
      lockingScriptHex: lockHex,
      customInstructions: rem.customInstructions,
      tags,
    })
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
      ...(classified.kind === 'bsv21' && classified.encoding === 'binary'
        ? { binarySupply: 'locked' as const }
        : {}),
      ...bsv21EncodingOf(classified),
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
      .filter((s) => s.satoshis === 1 && isBsv21OneSatLock(s.hex))
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
 * Seed Tokens immediately after a BSV-21 identity mint `createAction`.
 *
 * Activity used to record the mint while Tokens waited on a later `listOutputs`
 * (often deferred while spend/seal was still busy). Local AtomicBEEF already
 * has the tip — paint from it, no indexer.
 */
export function paintAfterCreateActionBsv21Mint(
  active: ActiveWallet,
  originator: string,
  args: unknown,
  result: unknown,
): number {
  if (!isBsv21IdentityMintArgs('createAction', args)) return 0
  void originator
  const txid = extractTxid(result) ?? extractTxid(args)
  if (!txid) return 0
  const scripts = lockingScriptsFromCreateAction(txid, args, result)
  let painted = 0
  for (const out of scripts) {
    if (out.satoshis !== 1) continue
    if (!scriptPaysAddress(out.hex, active.address)) continue
    const outpoint = `${txid}.${out.vout}`
    const classified = classifyOneSatAsBsv21({
      satoshis: 1,
      outpoint,
      lockingScriptHex: out.hex,
    })
    if (classified.kind !== 'bsv21') continue
    const amt = classified.payload.amt
    if (!amt || !/^\d+$/.test(amt) || BigInt(amt) <= 0n) continue
    const op = classified.payload.op
    if (op !== 'deploy+mint' && op !== 'mint' && op !== 'transfer') continue
    const token = fungibleFromImport({
      outpoint,
      txid,
      vout: out.vout,
      tokenId: classified.tokenId,
      amt,
      op,
      sym: classified.payload.sym || shortTokenLabel(classified.tokenId),
      dec: classified.payload.dec ?? 0,
      ...(classified.payload.icon
        ? { icon: normalizeTokenId(classified.payload.icon) ?? classified.payload.icon }
        : {}),
      ...(classified.payload.issuer ? { issuer: classified.payload.issuer } : {}),
      ...(classified.encoding === 'binary'
        ? { binarySupply: 'locked' as const }
        : {}),
      ...bsv21EncodingOf(classified),
    })
    rememberFungibleToken(token)
    void hydrateCachedTokenIcons(active, [token]).catch(() => {})
    painted += 1
  }
  if (painted > 0) {
    console.info(
      `[brc100] painted ${painted} BSV-21 mint tip(s) after createAction`,
    )
  }
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
      .filter((s) => s.satoshis === 1 && isBsv21OneSatLock(s.hex))
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
        method: 'mint-collectable',
        note: `Minted ${name}`,
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
