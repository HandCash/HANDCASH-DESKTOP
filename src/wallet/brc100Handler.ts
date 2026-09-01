import type { WalletInterface } from '@bsv/sdk'
import { Beef, Transaction } from '@bsv/sdk'
import { getActiveWallet, fetchFastBalanceSats } from './session'
import {
  filterItemOutputsForOrigin,
  filterTokenOutputsForOrigin,
  gateOriginAccess,
  isActionMethod,
  isPublicMethod,
  isSilentAuthMethod,
  normalizeOrigin,
  noteInboundWalletRequest,
  requestActionApproval,
  getTokenAccess,
  requestItemViewApproval,
  requestTokenViewApproval,
  requestIndexInstallApproval,
  requestIndexReadApproval,
  requestIndexSyncApproval,
  requestOverlayLookupApproval,
  filterIndexOutputsForOrigin,
} from './permissions'
import {
  emptyListOutputsResult,
  isColourBasket,
  isItemBasket,
  isItemReceiveArgs,
  isItemSpendArgs,
  isColourIssuanceArgs,
  isThirdPartyOriginator,
  isTokenViewBasket,
  p1SatSpendIds,
  prepareItemBasketArgs,
  shouldRefuseColourList,
  type ItemViewRequest,
  type TokenViewRequest,
} from './itemAccess'
import { isIndexBasket, prepareIndexBasketArgs, type IndexReadRequest } from './indexAccess'
import {
  installIndexExpansion,
  listIndexExpansionEntries,
  listIndexExpansions,
  listIndexBasketOutputs,
  overlayLookup,
  removeIndexExpansion,
  syncIndexExpansion,
} from './indexExpansion'
import { IndexManifestError } from './indexExpansionManifest'
import { extractSatsFromArgs, recordAppActivity, WALLET_ACTIVITY_ORIGIN, formatActivityTokenAmt, hasActivityItemOutpoint } from './appActivity'
import { scheduleHistoryBackupPush } from './deviceSync'
import { extractTxid } from './txExplorer'
import { parseOrdEnvelope } from './ordinalOwnership'
import { rememberTokenIcon, getTokenIconDataUrl } from './tokenIconCache'
import { resolveBsv21IconDataUrl } from './tokenIconResolve'
import { stampBsv21IconOnListedOutputs } from './colourListing'
import { rememberBeefBinary, hydrateInputBeef } from './beefCache'
import { addMarketOriginVerdicts } from './marketInventory'
import {
  enrichCreateActionForBsv21Issuer,
  finishBsv21IdentityMintCreateAction,
  isBsv21IdentityMintArgs,
  bsv21IdentityMintHints,
} from './bsv21Issuer'
import { normalizeTokenId } from './bsv21'
import {
  claimCloudHandlePayload,
  clearClaimedCloudHandlePayload,
  getClaimedCloudHandleVerified,
  isHandleClaimOrigin,
  isHandleClaimWriteMethod,
} from './handleClaim'
import {
  getLegacyAddressPayload,
  isMigrationMethod,
  isMigrationOrigin,
  listMigrationTxids,
  refreshLegacyAddressPayload,
} from './migration'
import {
  createCancelMarketListingAdvert,
  createMarketListingAdvert,
  createMarketPurchaseIntent,
  getMarketSettlementReceipt,
  getMarketSaleStatus,
  isMarketListingOrigin,
  markMarketListingPublishFailed,
  MarketListingError,
  marketListingPreviewFromArgs,
  purchaseMarketListing,
  verifyMarketListingProvenance,
  type CreateMarketListingArgs,
} from './marketListing'
import { playWalletSound } from './soundService'
import { requestUnlockForBridge } from './walletHealth'
import { assertOnlineForPayment } from './paymentPolicy'
import { prepareBrcActionSpend, runExclusiveSpend } from './spendGuard'
import { canAutoProcessPayment } from './autoPay'
import {
  clearPaymentProgress,
  marketBusyCopy,
  setPaymentProgress,
} from './paymentProgress'
import { validateWalletIdentityProofRequest } from './walletIdentityProof'
import { appendAppLog } from './appLog'
import { logBrc100Response, shouldLogBrc100Method } from './diagnosticLog'
import { paintAfterInternalizeItem } from './internalizeItemPaint'
import { flattenJsonError } from './errorText'

/** One market mutation per method/item, even if a browser repeats its request. */
const inFlightMarketActions = new Set<string>()

function marketOutpointFromArgs(args: unknown): string {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const top = String((args as { outpoint?: unknown }).outpoint ?? '').trim().toLowerCase()
    if (top) return top
  }
  return marketListingPreviewFromArgs(args)?.itemOutpoint?.toLowerCase() ?? ''
}

function marketActionKey(method: string, args: unknown): string {
  return `${method}:${marketOutpointFromArgs(args)}`
}

/**
 * Let React commit the permission → processing projection before wallet work.
 *
 * Resolving a permission wakes the suspended request in a microtask. Some
 * provenance and BEEF operations perform meaningful synchronous work before
 * their first await; without a frame boundary the renderer can remain painted
 * as "Approving…" even though approval already succeeded.
 */
function yieldForPermissionProjection(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0)
      return
    }
    requestAnimationFrame(() => setTimeout(resolve, 0))
  })
}

type HttpRequestEvent = {
  method: string
  path: string
  headers: Record<string, string>
  body: string
  request_id: number
}

function parseOrigin(headers: Record<string, string>): string | undefined {
  const rawOrigin = headers.origin
  const rawOriginator = headers.originator
  if (rawOrigin) {
    try {
      return new URL(rawOrigin).host
    } catch {
      return undefined
    }
  }
  if (rawOriginator) {
    try {
      const candidate = rawOriginator.includes('://') ? rawOriginator : `http://${rawOriginator}`
      return new URL(candidate).host
    } catch {
      return undefined
    }
  }
  return undefined
}

function methodFromPath(path: string): string {
  return path.replace(/^\//, '').split('?')[0] || ''
}

function normalizeOutpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/_(\d+)$/, '.$1')
  return /^[0-9a-f]{64}\.\d+$/.test(normalized) ? normalized : null
}

/**
 * Bind every BRC-165 id label to exactly one held `1sat` row and to an input
 * in this action. This prevents a label approval from authorizing a different
 * spend set than the row the user saw.
 */
async function verifyP1SatSpendLabels(
  wallet: WalletInterface,
  args: unknown,
): Promise<void> {
  const ids = p1SatSpendIds(args)
  if (ids.length === 0) return
  const body = args && typeof args === 'object' && !Array.isArray(args)
    ? (args as { inputs?: unknown[] })
    : {}
  const actionInputs = new Set(
    (body.inputs ?? []).flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return []
      const outpoint = normalizeOutpoint((raw as { outpoint?: unknown }).outpoint)
      return outpoint ? [outpoint] : []
    }),
  )
  for (const id of ids) {
    const listed = await wallet.listOutputs({
      basket: '1sat',
      tags: [`id:${id}`],
      tagQueryMode: 'all',
      limit: 2,
      includeTags: true,
      seekPermission: false,
    })
    if (listed.outputs.length !== 1) {
      throw new Error(`BRC-165 item id "${id}" does not resolve to exactly one held row`)
    }
    const heldOutpoint = normalizeOutpoint(listed.outputs[0]?.outpoint)
    if (!heldOutpoint || !actionInputs.has(heldOutpoint)) {
      throw new Error(`BRC-165 item id "${id}" is not an input in this action`)
    }
  }
}

/**
 * Cache image-inscription outputs we just authored (BSV-21 ticker icons).
 *
 * Prefer the **broadcast subject tx** (result.tx / AtomicBEEF): request
 * `args.outputs` indices do not match final vouts when `randomizeOutputs` is
 * on, and caching `txid_0` for a shuffled inscription points at change.
 */
function cacheImageIconsFromCreateAction(
  txid: string,
  args: unknown,
  result?: unknown,
): void {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return

  const cacheFromScript = (vout: number, scriptHex: string) => {
    const env = parseOrdEnvelope(scriptHex)
    if (!env?.contentType) return
    const mime = env.contentType.toLowerCase().split(';')[0]!.trim()
    if (!mime.startsWith('image/')) return
    rememberTokenIcon(`${id}_${vout}`, env.body, mime)
  }

  // 1) Subject transaction from createAction result (correct vouts).
  if (result && typeof result === 'object') {
    const raw = (result as { tx?: unknown }).tx
    let binary: number[] | null = null
    if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
      binary = raw as number[]
    } else if (raw instanceof Uint8Array) {
      binary = Array.from(raw)
    } else if (typeof raw === 'string' && raw.trim()) {
      try {
        const bin = atob(raw.trim())
        binary = Array.from(bin, (c) => c.charCodeAt(0))
      } catch {
        binary = null
      }
    }
    if (binary?.length) {
      try {
        const beef = Beef.fromBinary(binary)
        const tx = beef.findTxid(id)?.tx
        if (tx?.outputs?.length) {
          tx.outputs.forEach((out, vout) => {
            const hex = out?.lockingScript?.toHex?.()
            if (typeof hex === 'string' && hex) cacheFromScript(vout, hex)
          })
          return
        }
      } catch {
        // not AtomicBEEF
      }
      try {
        const tx = Transaction.fromBinary(binary)
        tx.outputs.forEach((out, vout) => {
          const hex = out?.lockingScript?.toHex?.()
          if (typeof hex === 'string' && hex) cacheFromScript(vout, hex)
        })
        return
      } catch {
        // fall through to request outputs
      }
    }
  }

  // 2) Fallback: request outputs only when randomization was off / single out.
  if (!args || typeof args !== 'object' || Array.isArray(args)) return
  const outputs = (args as { outputs?: unknown }).outputs
  if (!Array.isArray(outputs)) return
  for (let vout = 0; vout < outputs.length; vout++) {
    const raw = outputs[vout]
    if (!raw || typeof raw !== 'object') continue
    const script = (raw as { lockingScript?: unknown }).lockingScript
    if (typeof script !== 'string' || !script) continue
    cacheFromScript(vout, script)
  }
}

/** Keep AtomicBEEF / tx bytes from createAction so a follow-up spend can prove inputs. */
async function cacheCreateActionBeef(
  active: NonNullable<ReturnType<typeof getActiveWallet>>,
  txid: string,
  result: unknown,
): Promise<void> {
  if (!result || typeof result !== 'object') return
  const raw = (result as { tx?: unknown }).tx
  let binary: number[] | null = null
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
    binary = raw as number[]
  } else if (raw instanceof Uint8Array) {
    binary = Array.from(raw)
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const bin = atob(raw.trim())
      binary = Array.from(bin, (c) => c.charCodeAt(0))
    } catch {
      binary = null
    }
  }
  if (!binary?.length) return
  const id = txid.trim().toLowerCase()
  try {
    const asBeef = Beef.fromBinary(binary)
    asBeef.atomicTxid = undefined
    const shaped = await hydrateInputBeef(active, asBeef)
    if (shaped && Beef.fromBinary(shaped).findTxid(id)?.tx) {
      rememberBeefBinary(id, shaped)
      return
    }
  } catch {
    // not AtomicBEEF / not shapeable
  }
  try {
    const wrapped = new Beef()
    wrapped.mergeTransaction(Transaction.fromBinary(binary))
    wrapped.atomicTxid = undefined
    const shaped = await hydrateInputBeef(active, wrapped)
    if (shaped && Beef.fromBinary(shaped).findTxid(id)?.tx) {
      rememberBeefBinary(id, shaped)
    }
  } catch {
    // ignore — follow-up spend may still fetch from services
  }
}

/**
 * 1Sat FT genesis mint — activity as minted token (not a plain BSV spend or
 * collectable receive). Icon sibling is decorative; face-value tip is the row.
 */
function recordColourMintActivity(
  txid: string,
  args: unknown,
  originator: string | undefined,
): boolean {
  const id = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(id)) return false
  const outputs =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { outputs?: unknown[] }).outputs
      : undefined
  if (!Array.isArray(outputs)) return false

  let recorded = false
  for (let vout = 0; vout < outputs.length; vout++) {
    const raw = outputs[vout]
    if (!raw || typeof raw !== 'object') continue
    const out = raw as {
      basket?: string
      tags?: string[]
      customInstructions?: string
    }
    if ((out.basket ?? '').trim().toLowerCase() !== '1sat-ft') continue

    let sym = 'Token'
    let amt: string | null = null
    let icon: string | null = null
    let iconVout: number | null = null
    for (const tag of out.tags ?? []) {
      const t = tag.trim()
      const lower = t.toLowerCase()
      if (lower.startsWith('sym:')) sym = t.slice(4).trim() || sym
      if (lower.startsWith('icon:')) {
        icon = normalizeTokenId(t.slice(5)) || icon
      }
      if (lower.startsWith('iconvout:')) {
        const n = Number(t.slice('iconvout:'.length).trim())
        if (Number.isSafeInteger(n) && n >= 0) iconVout = n
      }
    }
    if (out.customInstructions) {
      try {
        const ci = JSON.parse(out.customInstructions) as {
          sym?: unknown
          amt?: unknown
          icon?: unknown
          iconVout?: unknown
        }
        if (typeof ci.sym === 'string' && ci.sym.trim()) sym = ci.sym.trim()
        if (typeof ci.amt === 'string' && ci.amt.trim()) amt = ci.amt.trim()
        else if (typeof ci.amt === 'number' && Number.isSafeInteger(ci.amt)) {
          amt = String(ci.amt)
        }
        if (typeof ci.icon === 'string') {
          icon = normalizeTokenId(ci.icon) || icon
        }
        if (
          typeof ci.iconVout === 'number' &&
          Number.isSafeInteger(ci.iconVout) &&
          ci.iconVout >= 0
        ) {
          iconVout = ci.iconVout
        }
      } catch {
        // ignore
      }
    }
    if (!icon && iconVout != null) icon = `${id}_${iconVout}`
    if (!amt) continue

    const tokenId = `${id}_${vout}`
    const outpoint = `${id}.${vout}`
    const imageUrl = icon ? getTokenIconDataUrl(icon) : undefined
    recorded = true
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'mint-token',
      note: `Minted ${formatActivityTokenAmt(amt, 0)} ${sym}`,
      txid: id,
      item: {
        name: sym,
        origin: tokenId,
        outpoint,
        tokenId,
        amt,
        dec: 0,
        ...(icon ? { icon } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      },
    })
  }
  return recorded
}

/**
 * Identity mint / remint: activity as minted tokens (not a plain receive or BSV spend).
 * Mint tips use tip outpoint as the activity key; genesis-only deploy+auth is an event.
 */
function recordIdentityMintActivity(
  txid: string,
  args: unknown,
  originator: string | undefined,
): void {
  const hints = bsv21IdentityMintHints(args)
  const sym = hints.sym?.trim() || 'Token'
  const outputs =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { outputs?: unknown[] }).outputs
      : undefined
  if (!Array.isArray(outputs) || outputs.length === 0) {
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'event',
      sats: 0,
      method: 'mint-token',
      note: hints.amt
        ? `Minted ${formatActivityTokenAmt(hints.amt, hints.dec ?? 0)} ${sym}`
        : `Minted ${sym}`,
      txid,
    })
    return
  }

  const id = txid.trim().toLowerCase()
  let recordedMint = false
  for (let vout = 0; vout < outputs.length; vout++) {
    const raw = outputs[vout]
    if (!raw || typeof raw !== 'object') continue
    const out = raw as {
      basket?: string
      tags?: string[]
      customInstructions?: string
    }
    if ((out.basket ?? '').trim().toLowerCase() !== 'bsv21') continue
    let op = ''
    let tokenId: string | null = null
    let amt: string | null = hints.amt
    let tipSym = sym
    let dec: number | undefined = hints.dec ?? undefined
    let icon: string | null = hints.icon
    for (const tag of out.tags ?? []) {
      const t = tag.trim()
      const lower = t.toLowerCase()
      if (lower.startsWith('op:')) op = t.slice(3).trim().toLowerCase()
      if (lower.startsWith('bsv21:')) {
        tokenId = normalizeTokenId(t.slice('bsv21:'.length))
      }
      if (lower.startsWith('amt:')) amt = t.slice(4).trim() || amt
      if (lower.startsWith('sym:')) tipSym = t.slice(4).trim() || tipSym
      if (lower.startsWith('dec:')) {
        const n = Number(t.slice(4).trim())
        if (Number.isInteger(n) && n >= 0 && n <= 18) dec = n
      }
      if (lower.startsWith('icon:')) {
        icon = normalizeTokenId(t.slice(5)) || icon
      }
    }
    if (out.customInstructions) {
      try {
        const ci = JSON.parse(out.customInstructions) as {
          op?: unknown
          id?: unknown
          amt?: unknown
          sym?: unknown
          dec?: unknown
          icon?: unknown
        }
        if (!op && typeof ci.op === 'string') op = ci.op.trim().toLowerCase()
        if (!tokenId && typeof ci.id === 'string') {
          tokenId = normalizeTokenId(ci.id)
        }
        if (!amt && typeof ci.amt === 'string') amt = ci.amt.trim()
        if (typeof ci.sym === 'string' && ci.sym.trim()) tipSym = ci.sym.trim()
        if (
          dec == null &&
          typeof ci.dec === 'number' &&
          Number.isInteger(ci.dec) &&
          ci.dec >= 0 &&
          ci.dec <= 18
        ) {
          dec = ci.dec
        }
        if (!icon && typeof ci.icon === 'string') {
          icon = normalizeTokenId(ci.icon)
        }
      } catch {
        // ignore
      }
    }
    if (op === 'deploy+mint') {
      tokenId = tokenId ?? normalizeTokenId(`${id}_${vout}`)
    }
    if (op !== 'mint' && op !== 'deploy+mint') continue
    if (!tokenId || !amt) continue
    const outpoint = `${id}.${vout}`
    recordedMint = true
    const qty = formatActivityTokenAmt(amt, dec ?? 0)
    const imageUrl = icon ? getTokenIconDataUrl(icon) : undefined
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'earned',
      sats: 1,
      method: 'mint-token',
      note: `Minted ${qty} ${tipSym}`,
      txid: id,
      item: {
        name: tipSym,
        origin: tokenId,
        outpoint,
        tokenId,
        amt,
        ...(dec != null ? { dec } : {}),
        ...(icon ? { icon } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      },
    })
  }

  if (!recordedMint) {
    // deploy+auth (or mint args without parseable tip) — still surface the action.
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'event',
      sats: 0,
      method: 'mint-token',
      note: hints.amt
        ? `Minted ${formatActivityTokenAmt(hints.amt, hints.dec ?? 0)} ${sym}`
        : `Deployed ${sym}`,
      txid: id,
    })
  }
}

/**
 * App createAction that transfers BSV-21 tips — record as send-token (not a 1-sat BSV spend).
 * Returns true when at least one tip was recorded.
 */
function recordBsv21TransferSends(
  txid: string,
  args: unknown,
  originator: string | undefined,
): boolean {
  const outputs =
    args && typeof args === 'object' && !Array.isArray(args)
      ? (args as { outputs?: unknown[] }).outputs
      : undefined
  if (!Array.isArray(outputs) || outputs.length === 0) return false

  const id = txid.trim().toLowerCase()
  let recorded = false
  for (let vout = 0; vout < outputs.length; vout++) {
    const raw = outputs[vout]
    if (!raw || typeof raw !== 'object') continue
    const out = raw as {
      basket?: string
      tags?: string[]
      customInstructions?: string
    }
    if ((out.basket ?? '').trim().toLowerCase() !== 'bsv21') continue
    let op = ''
    let tokenId: string | null = null
    let amt: string | null = null
    let tipSym = 'Token'
    let dec: number | undefined
    let icon: string | null = null
    for (const tag of out.tags ?? []) {
      const t = tag.trim()
      const lower = t.toLowerCase()
      if (lower.startsWith('op:')) op = t.slice(3).trim().toLowerCase()
      if (lower.startsWith('bsv21:')) {
        tokenId = normalizeTokenId(t.slice('bsv21:'.length))
      }
      if (lower.startsWith('id:')) tokenId = normalizeTokenId(t.slice(3))
      if (lower.startsWith('amt:')) amt = t.slice(4).trim() || amt
      if (lower.startsWith('sym:')) tipSym = t.slice(4).trim() || tipSym
      if (lower.startsWith('dec:')) {
        const n = Number(t.slice(4).trim())
        if (Number.isInteger(n) && n >= 0 && n <= 18) dec = n
      }
      if (lower.startsWith('icon:')) {
        icon = normalizeTokenId(t.slice(5)) || icon
      }
    }
    if (out.customInstructions) {
      try {
        const ci = JSON.parse(out.customInstructions) as {
          op?: unknown
          id?: unknown
          amt?: unknown
          sym?: unknown
          dec?: unknown
          icon?: unknown
        }
        if (!op && typeof ci.op === 'string') op = ci.op.trim().toLowerCase()
        if (!tokenId && typeof ci.id === 'string') {
          tokenId = normalizeTokenId(ci.id)
        }
        if (!amt && typeof ci.amt === 'string') amt = ci.amt.trim()
        if (typeof ci.sym === 'string' && ci.sym.trim()) tipSym = ci.sym.trim()
        if (
          dec == null &&
          typeof ci.dec === 'number' &&
          Number.isInteger(ci.dec) &&
          ci.dec >= 0 &&
          ci.dec <= 18
        ) {
          dec = ci.dec
        }
        if (!icon && typeof ci.icon === 'string') {
          icon = normalizeTokenId(ci.icon)
        }
      } catch {
        // ignore
      }
    }
    if (op !== 'transfer') continue
    if (!tokenId || !amt) continue
    const outpoint = `${id}.${vout}`
    if (hasActivityItemOutpoint(outpoint)) continue
    recorded = true
    const qty = formatActivityTokenAmt(amt, dec ?? 0)
    const imageUrl = icon ? getTokenIconDataUrl(icon) : undefined
    recordAppActivity({
      origin: originator ?? WALLET_ACTIVITY_ORIGIN,
      kind: 'spent',
      sats: 1,
      method: 'send-token',
      note: `Sent ${qty} ${tipSym}`,
      txid: id,
      item: {
        name: tipSym,
        origin: tokenId,
        outpoint,
        tokenId,
        amt,
        ...(dec != null ? { dec } : {}),
        ...(icon ? { icon } : {}),
        ...(imageUrl ? { imageUrl } : {}),
      },
    })
  }
  return recorded
}

async function dispatchWalletMethod(
  wallet: WalletInterface,
  method: string,
  args: unknown,
  originator?: string,
): Promise<unknown> {
  const w = wallet as WalletInterface & Record<string, (a?: unknown, o?: string) => Promise<unknown>>

  switch (method) {
    case 'getLegacyAddress':
      return getLegacyAddressPayload()
    case 'refreshLegacyAddress':
      return refreshLegacyAddressPayload(
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as { txids?: string[]; items?: Array<{ outpoint: string; origin?: string; txid?: string; vout?: number }> })
          : undefined,
      )
    case 'listMigrationTxids':
      return listMigrationTxids()
    case 'createMarketListingAdvert':
      return createMarketListingAdvert((args ?? {}) as CreateMarketListingArgs)
    case 'getTokenIcon': {
      const body =
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as { icon?: unknown; origin?: unknown; outpoint?: unknown })
          : {}
      const icon = typeof body.icon === 'string' ? body.icon.trim() : ''
      const origin = typeof body.origin === 'string' ? body.origin.trim() : ''
      // Same originator as listOutputs bsv21 — if View tokens was already
      // Allowed, do not prompt again. First Allow persists on the originator.
      if (getTokenAccess(originator).view === 'none') {
        const decision = await requestTokenViewApproval(originator, { basket: 'bsv21' })
        if (decision !== 'allow') return { dataUrl: null }
      }
      const dataUrl = await resolveBsv21IconDataUrl({
        icon: icon || undefined,
        origin: origin || (typeof body.outpoint === 'string' ? body.outpoint : undefined),
        wallet: getActiveWallet(),
      })
      return { dataUrl: dataUrl ?? null }
    }
    case 'createMarketPurchaseIntent':
      return createMarketPurchaseIntent(
        (args ?? {}) as Parameters<typeof createMarketPurchaseIntent>[0]
      )
    case 'verifyMarketListingProvenance':
      return verifyMarketListingProvenance(
        (args ?? {}) as Parameters<typeof verifyMarketListingProvenance>[0],
      )
    case 'purchaseMarketListing':
      return purchaseMarketListing(
        (args ?? {}) as Parameters<typeof purchaseMarketListing>[0],
      )
    case 'getMarketSettlementReceipt':
      return getMarketSettlementReceipt(
        (args ?? {}) as Parameters<typeof getMarketSettlementReceipt>[0],
      )
    case 'createCancelMarketListingAdvert':
      return createCancelMarketListingAdvert(
        (args ?? {}) as Parameters<typeof createCancelMarketListingAdvert>[0],
      )
    case 'getMarketListingStatus':
      return getMarketSaleStatus(
        (args ?? {}) as Parameters<typeof getMarketSaleStatus>[0],
      )
    case 'markMarketListingPublishFailed':
      markMarketListingPublishFailed(
        (args ?? {}) as { txid?: string; reason?: string },
      )
      return { ok: true }
    case 'claimCloudHandle':
      return claimCloudHandlePayload(
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as { handle: string; claimTicket?: string })
          : { handle: '' },
      )
    case 'getClaimedCloudHandle':
      return getClaimedCloudHandleVerified()
    case 'clearClaimedCloudHandle':
      return clearClaimedCloudHandlePayload()
    case 'installIndexExpansion':
      return installIndexExpansion({
        body: (args ?? {}) as Parameters<typeof installIndexExpansion>[0]['body'],
        origin: originator,
      })
    case 'listIndexExpansions':
      return listIndexExpansions()
    case 'removeIndexExpansion':
      return removeIndexExpansion((args ?? {}) as { packId: string })
    case 'syncIndexExpansion':
      return syncIndexExpansion({
        body: (args ?? {}) as Parameters<typeof syncIndexExpansion>[0]['body'],
        origin: originator,
      })
    case 'listIndexExpansionEntries':
      return listIndexExpansionEntries(
        (args ?? {}) as Parameters<typeof listIndexExpansionEntries>[0],
      )
    case 'overlayLookup':
      return overlayLookup({
        body: (args ?? {}) as Parameters<typeof overlayLookup>[0]['body'],
      })
    case 'getVersion':
      return wallet.getVersion({})
    case 'getNetwork':
      return wallet.getNetwork({})
    case 'isAuthenticated':
      return { authenticated: true }
    case 'waitForAuthentication':
      return { authenticated: true }
    case 'getPublicKey':
      return wallet.getPublicKey((args ?? {}) as never, originator)
    case 'createAction':
      return wallet.createAction((args ?? {}) as never, originator)
    case 'signAction':
      return wallet.signAction((args ?? {}) as never, originator)
    case 'abortAction':
      return wallet.abortAction((args ?? {}) as never, originator)
    case 'listActions':
      return wallet.listActions((args ?? {}) as never, originator)
    case 'internalizeAction':
      return wallet.internalizeAction((args ?? {}) as never, originator)
    case 'listOutputs': {
      const basket =
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as { basket?: unknown }).basket
          : undefined
      if (isIndexBasket(basket)) {
        return listIndexBasketOutputs(args)
      }
      return wallet.listOutputs((args ?? {}) as never, originator)
    }
    case 'relinquishOutput':
      return wallet.relinquishOutput((args ?? {}) as never, originator)
    case 'getBalance': {
      const satoshis = await fetchFastBalanceSats(wallet)
      return { satoshis }
    }
    case 'encrypt':
      return wallet.encrypt((args ?? {}) as never, originator)
    case 'decrypt':
      return wallet.decrypt((args ?? {}) as never, originator)
    case 'createHmac':
      return wallet.createHmac((args ?? {}) as never, originator)
    case 'verifyHmac':
      return wallet.verifyHmac((args ?? {}) as never, originator)
    case 'createSignature':
      return wallet.createSignature((args ?? {}) as never, originator)
    case 'verifySignature':
      return wallet.verifySignature((args ?? {}) as never, originator)
    case 'acquireCertificate':
      return wallet.acquireCertificate((args ?? {}) as never, originator)
    case 'listCertificates':
      return wallet.listCertificates((args ?? {}) as never, originator)
    case 'proveCertificate':
      return wallet.proveCertificate((args ?? {}) as never, originator)
    case 'relinquishCertificate':
      return wallet.relinquishCertificate((args ?? {}) as never, originator)
    case 'discoverByIdentityKey':
      return wallet.discoverByIdentityKey((args ?? {}) as never, originator)
    case 'discoverByAttributes':
      return wallet.discoverByAttributes((args ?? {}) as never, originator)
    case 'revealCounterpartyKeyLinkage':
      return wallet.revealCounterpartyKeyLinkage((args ?? {}) as never, originator)
    case 'revealSpecificKeyLinkage':
      return wallet.revealSpecificKeyLinkage((args ?? {}) as never, originator)
    case 'getHeight':
      return wallet.getHeight({})
    case 'getHeaderForHeight':
      return wallet.getHeaderForHeight((args ?? {}) as never)
    default: {
      if (typeof w[method] === 'function') {
        return w[method](args, originator)
      }
      throw new Error(`Unsupported BRC-100 method: ${method}`)
    }
  }
}

export async function handleBrc100Request(event: HttpRequestEvent): Promise<{ status: number; body: string }> {
  const releaseInbound = noteInboundWalletRequest()
  const method = methodFromPath(event.path)
  const originator = parseOrigin(event.headers)
  const diag = shouldLogBrc100Method(method)
  const t0 = diag ? Date.now() : 0
  let args: unknown
  if (event.body) {
    try {
      args = JSON.parse(event.body)
    } catch {
      args = event.body
    }
  }
  try {
    const result = await handleBrc100RequestInner(event)
    if (diag && method) {
      try {
        logBrc100Response(method, originator, result, Date.now() - t0, args)
      } catch (err) {
        appendAppLog(
          'warn',
          `[brc100] diagnostic log skipped: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return result
  } finally {
    releaseInbound()
  }
}

async function handleBrc100RequestInner(event: HttpRequestEvent): Promise<{ status: number; body: string }> {
  if (event.method === 'OPTIONS') {
    return { status: 200, body: '' }
  }

  const method = methodFromPath(event.path)
  if (!method || method === 'manifest.json' || method === 'favicon.ico') {
    return { status: 404, body: JSON.stringify({ status: 'error', description: 'Not found' }) }
  }

  const active = getActiveWallet()
  if (!active) {
    requestUnlockForBridge()
    return {
      status: 503,
      body: JSON.stringify({
        status: 'error',
        code: 'WALLET_LOCKED',
        description: 'Unlock HandCash to use the BRC-100 interface.',
      }),
    }
  }

  let args: unknown = undefined
  let itemViewRequest: ItemViewRequest | undefined
  let tokenViewRequest: TokenViewRequest | undefined
  let indexReadRequest: IndexReadRequest | undefined
  if (event.body) {
    try {
      args = JSON.parse(event.body)
    } catch {
      args = event.body
    }
  }

  const originator = parseOrigin(event.headers)

  // Discovery / silent auth / connect prompt: skip basket rewrite. Do not
  // queue getVersion or isAuthenticated behind runExclusiveSpend.
  if (!isPublicMethod(method) && !isSilentAuthMethod(method) && method !== 'waitForAuthentication') {
    const indexPrepared = prepareIndexBasketArgs(args)
    if (indexPrepared.error) {
      return {
        status: 400,
        body: JSON.stringify({
          status: 'error',
          code: indexPrepared.error.code,
          description: indexPrepared.error.description,
        }),
      }
    }
    args = indexPrepared.args
    indexReadRequest = indexPrepared.indexReadRequest

    const prepared = prepareItemBasketArgs(args)
    if (prepared.error) {
      return {
        status: 400,
        body: JSON.stringify({
          status: 'error',
          code: prepared.error.code,
          description: prepared.error.description,
        }),
      }
    }
    args = prepared.args
    itemViewRequest = prepared.itemViewRequest
    tokenViewRequest = prepared.tokenViewRequest
  }

  const access = await gateOriginAccess(originator, method)
  if (access === 'unauthenticated') {
    if (method === 'isAuthenticated' || method === 'waitForAuthentication') {
      return { status: 200, body: JSON.stringify({ authenticated: false }) }
    }
    return {
      status: 401,
      body: JSON.stringify({
        status: 'error',
        code: 'NOT_AUTHENTICATED',
        description: 'This app is not allowed to use the wallet. Call waitForAuthentication first.',
      }),
    }
  }
  if (access === 'deny') {
    return {
      status: 403,
      body: JSON.stringify({
        status: 'error',
        code: 'PERMISSION_DENIED',
        description: 'You denied this app access to HandCash.',
      }),
    }
  }

  if (isMigrationMethod(method) && !isMigrationOrigin(originator)) {
    // A silent 403 here looks like an import that simply never happened, so
    // name the refused origin in the session log.
    appendAppLog(
      'warn',
      `[migrate] refused ${method} from ${normalizeOrigin(originator) || 'unknown origin'}`,
    )
    return {
      status: 403,
      body: JSON.stringify({
        status: 'error',
        code: 'MIGRATION_ORIGIN_DENIED',
        description: 'Migration methods are only available to HandCash web hosts.',
      }),
    }
  }

  if (
    [
      'createMarketListingAdvert',
      'createMarketPurchaseIntent',
      'verifyMarketListingProvenance',
      'purchaseMarketListing',
      'getMarketSettlementReceipt',
      'createCancelMarketListingAdvert',
      'getMarketListingStatus',
      'markMarketListingPublishFailed',
      'getTokenIcon',
    ].includes(method) &&
    !isMarketListingOrigin(originator)
  ) {
    return {
      status: 403,
      body: JSON.stringify({
        status: 'error',
        code: 'MARKET_ORIGIN_DENIED',
        description: 'Market listing is only available to HandCash market hosts.',
      }),
    }
  }

  // Mint / clear stay HandCash-hosted. Read (`getClaimedCloudHandle`) is open to
  // any authenticated app — Free Radio already proved the identity key and needs
  // the bound handle without a username field that only localhost would allow.
  if (isHandleClaimWriteMethod(method) && !isHandleClaimOrigin(originator)) {
    return {
      status: 403,
      body: JSON.stringify({
        status: 'error',
        code: 'MIGRATION_ORIGIN_DENIED',
        description: 'Handle claim is only available to HandCash web hosts.',
      }),
    }
  }

  if (method === 'createSignature') {
    const proof = validateWalletIdentityProofRequest(
      args,
      normalizeOrigin(originator),
    )
    if (proof.kind === 'invalid') {
      return {
        status: 400,
        body: JSON.stringify({
          status: 'error',
          code: 'INVALID_IDENTITY_PROOF',
          description: proof.reason,
        }),
      }
    }
  }

  if (method === 'installIndexExpansion') {
    const installDecision = await requestIndexInstallApproval(originator, args)
    if (installDecision !== 'allow') {
      return {
        status: 403,
        body: JSON.stringify({
          status: 'error',
          code: 'INDEX_INSTALL_DENIED',
          description: 'You denied installing this catalog pack.',
        }),
      }
    }
    await yieldForPermissionProjection()
  }

  if (method === 'syncIndexExpansion') {
    const syncDecision = await requestIndexSyncApproval(originator, args)
    if (syncDecision !== 'allow') {
      return {
        status: 403,
        body: JSON.stringify({
          status: 'error',
          code: 'INDEX_SYNC_DENIED',
          description: 'You denied syncing this catalog pack.',
        }),
      }
    }
    await yieldForPermissionProjection()
  }

  if (method === 'listIndexExpansionEntries') {
    const body =
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as { packId?: unknown; live?: unknown })
        : {}
    const packId = String(body.packId ?? '').trim()
    const readDecision = await requestIndexReadApproval(originator, packId)
    if (readDecision !== 'allow') {
      return {
        status: 403,
        body: JSON.stringify({
          status: 'error',
          code: 'INDEX_READ_DENIED',
          description: 'You denied reading this catalog cache.',
        }),
      }
    }
    await yieldForPermissionProjection()
  }

  if (method === 'overlayLookup') {
    const lookupDecision = await requestOverlayLookupApproval(originator, args)
    if (lookupDecision !== 'allow') {
      return {
        status: 403,
        body: JSON.stringify({
          status: 'error',
          code: 'OVERLAY_LOOKUP_DENIED',
          description: 'You denied live overlay lookup.',
        }),
      }
    }
    await yieldForPermissionProjection()
  }

  if (isActionMethod(method)) {
    if (method === 'createAction' && p1SatSpendIds(args).length > 0) {
      try {
        await verifyP1SatSpendLabels(active.wallet, args)
      } catch (err) {
        return {
          status: 400,
          body: JSON.stringify({
            status: 'error',
            code: 'INVALID_P1SAT_SPEND',
            description: err instanceof Error ? err.message : String(err),
          }),
        }
      }
    }
    if (method === 'createAction' || method === 'signAction') {
      try {
        assertOnlineForPayment()
        // Local toolbox / history backup is authoritative — no chain heal before
        // pay. Still refuse auto-pay when local balance cannot cover the ask.
        const amountSats = extractSatsFromArgs(method, args)
        const silentAutoPay =
          !isItemSpendArgs(method, args) &&
          !isBsv21IdentityMintArgs(method, args) &&
          canAutoProcessPayment(normalizeOrigin(originator), method, amountSats)
        if (silentAutoPay) {
          await prepareBrcActionSpend(method, args)
        }
      } catch (err) {
        const description = err instanceof Error ? err.message : String(err)
        const offline = /offline/i.test(description)
        return {
          status: offline ? 503 : 400,
          body: JSON.stringify({
            status: 'error',
            code: offline ? 'OFFLINE_PAYMENTS_DISABLED' : 'INSUFFICIENT_OR_STALE_FUNDS',
            description,
          }),
        }
      }
    }
    const actionDecision = await requestActionApproval(originator, method, args)
    if (actionDecision !== 'allow') {
      return {
        status: 403,
        body: JSON.stringify({
          status: 'error',
          code: 'ACTION_DENIED',
          description: 'You denied this transaction or signing request.',
        }),
      }
    }
    await yieldForPermissionProjection()
  }

  if (method === 'listOutputs') {
    const basket =
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as { basket?: unknown }).basket
        : undefined
    if (shouldRefuseColourList(originator, basket) || (isColourBasket(basket) && isThirdPartyOriginator(originator))) {
      return {
        status: 200,
        body: JSON.stringify(emptyListOutputsResult()),
      }
    }
    if (isTokenViewBasket(basket)) {
      const viewDecision = await requestTokenViewApproval(originator, args, tokenViewRequest)
      if (viewDecision !== 'allow') {
        return {
          status: 403,
          body: JSON.stringify({
            status: 'error',
            code: 'TOKEN_VIEW_DENIED',
            description: 'You denied this app access to view tokens.',
          }),
        }
      }
    } else if (isItemBasket(basket)) {
      const viewDecision = await requestItemViewApproval(originator, args, itemViewRequest)
      if (viewDecision !== 'allow') {
        return {
          status: 403,
          body: JSON.stringify({
            status: 'error',
            code: 'ITEM_VIEW_DENIED',
            description: 'You denied this app access to view collectables.',
          }),
        }
      }
    } else if (isIndexBasket(basket) && isThirdPartyOriginator(originator)) {
      const packId = indexReadRequest?.packId ?? ''
      const readDecision = await requestIndexReadApproval(originator, packId)
      if (readDecision !== 'allow') {
        return {
          status: 403,
          body: JSON.stringify({
            status: 'error',
            code: 'INDEX_READ_DENIED',
            description: 'You denied reading this catalog cache.',
          }),
        }
      }
    }
  }

  try {
    let result: unknown
    if (method === 'createAction' || method === 'signAction') {
      try {
        setPaymentProgress('preparing', 'Waiting to send…')
        result = await runExclusiveSpend(
          async () => {
            // Local balance check only — never block on address scan / chain ingest.
            await prepareBrcActionSpend(method, args)
            let actionArgs = args
            if (method === 'createAction' && args && typeof args === 'object') {
              try {
                setPaymentProgress('preparing', 'Preparing payment')
                actionArgs = await enrichCreateActionForBsv21Issuer(
                  active,
                  args as Parameters<typeof enrichCreateActionForBsv21Issuer>[1],
                )
              } catch (err) {
                console.warn('[bsv21-issuer] enrich createAction failed', err)
                // Identity mints with tip spends need inputBEEF — do not fall
                // through to createAction or the toolbox error is opaque.
                if (isBsv21IdentityMintArgs('createAction', args)) throw err
              }
            }
            setPaymentProgress(
              'broadcasting',
              'Signing and sending to the network',
            )
            const created = await dispatchWalletMethod(
              active.wallet,
              method,
              actionArgs,
              originator,
            )
            // Auth / Sigma fund tips use unlockingScriptLength → signable only.
            // Complete with root P2PKH so the app gets a txid (collectables pattern).
            if (method === 'createAction') {
              try {
                return await finishBsv21IdentityMintCreateAction(
                  active,
                  actionArgs,
                  created,
                )
              } catch (err) {
                console.warn('[bsv21-issuer] finish signable mint failed', err)
                throw err
              }
            }
            return created
          },
          () => {
            setPaymentProgress('preparing', 'Preparing payment')
          },
        )
        setPaymentProgress('finishing', 'Updating your balance')
      } catch (err) {
        clearPaymentProgress()
        const description = err instanceof Error ? err.message : String(err)
        const offline = /offline/i.test(description)
        return {
          status: offline ? 503 : 400,
          body: JSON.stringify({
            status: 'error',
            code: offline ? 'OFFLINE_PAYMENTS_DISABLED' : 'INSUFFICIENT_OR_STALE_FUNDS',
            description,
          }),
        }
      } finally {
        clearPaymentProgress()
      }
    } else if (
      method === 'createMarketListingAdvert' ||
      method === 'createCancelMarketListingAdvert' ||
      method === 'purchaseMarketListing'
    ) {
      // Keep the wallet visibly busy after the permission prompt resolves.
      // These methods sign and may broadcast, but unlike generic createAction
      // they dispatch through the market module and previously left no wallet
      // representation while the browser was still waiting. The market
      // transaction/state machine remains the authority; this is UI lifecycle
      // only and cannot alter settlement or cancellation semantics.
      const busy = marketBusyCopy(method) ?? {
        label: 'Working…',
        detail: 'Processing market request',
      }
      const outpoint = marketOutpointFromArgs(args) || null
      const actionKey = marketActionKey(method, args)
      if (inFlightMarketActions.has(actionKey)) {
        return {
          status: 409,
          body: JSON.stringify({
            status: 'error',
            code: 'ACTION_IN_PROGRESS',
            description: 'This market action is already in progress.',
          }),
        }
      }
      inFlightMarketActions.add(actionKey)
      try {
        setPaymentProgress('preparing', busy.detail, outpoint, busy.label)
        result = await dispatchWalletMethod(active.wallet, method, args, originator)
        setPaymentProgress('finishing', 'Updating market state', outpoint, busy.label)
      } finally {
        inFlightMarketActions.delete(actionKey)
        clearPaymentProgress()
      }
    } else if (method === 'internalizeAction') {
      // Serialize with spends — concurrent internalize mid-broadcast can thrash outs.
      result = await runExclusiveSpend(() =>
        dispatchWalletMethod(active.wallet, method, args, originator),
      )
    } else {
      // Reads share the wallet with background ingest but must not raise spend
      // priority. Mint Studio / explorers poll `listOutputs` while a ticker is
      // open; each hold was starving the Dashboard poll and firing the
      // "Network slow" soft deadline. Mutating methods already raise priority
      // inside `runExclusiveSpend`.
      result = await dispatchWalletMethod(active.wallet, method, args, originator)
    }

    if (method === 'listOutputs') {
      const basket =
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as { basket?: unknown }).basket
          : undefined
      if (isColourBasket(basket) && isThirdPartyOriginator(originator)) {
        result = emptyListOutputsResult()
      } else if (isTokenViewBasket(basket)) {
        result = stampBsv21IconOnListedOutputs(
          filterTokenOutputsForOrigin(originator, result, tokenViewRequest),
        )
      } else if (isItemBasket(basket)) {
        result = filterItemOutputsForOrigin(originator, result, itemViewRequest)
        if (isMarketListingOrigin(originator)) {
          result = addMarketOriginVerdicts(result)
        }
      } else if (isIndexBasket(basket)) {
        result = filterIndexOutputsForOrigin(
          originator,
          result,
          indexReadRequest?.packId,
        )
      }
    }

    if (method === 'refreshLegacyAddress') {
      const payload = result as { importedCount?: number; importedItemsCount?: number } | null
      const funds = payload?.importedCount ?? 0
      const items = payload?.importedItemsCount ?? 0
      if (funds > 0 || items > 0) playWalletSound('receive')
      else playWalletSound('soft')
    } else if (method === 'createAction') {
      const txid = extractTxid(result)
      if (txid) {
        cacheImageIconsFromCreateAction(txid, args, result)
        void cacheCreateActionBeef(active, txid, result)
      }
      if (isBsv21IdentityMintArgs(method, args) && txid) {
        recordIdentityMintActivity(txid, args, originator)
        playWalletSound('success')
      } else if (txid && isColourIssuanceArgs(method, args) && recordColourMintActivity(txid, args, originator)) {
        playWalletSound('success')
      } else if (txid && recordBsv21TransferSends(txid, args, originator)) {
        playWalletSound('success')
      } else {
        const sats = extractSatsFromArgs(method, args)
        if (sats > 0) {
          recordAppActivity({
            origin: originator,
            kind: 'spent',
            sats,
            method,
            note: typeof (args as { description?: string })?.description === 'string'
              ? (args as { description: string }).description
              : undefined,
            txid,
          })
          playWalletSound('success')
        } else {
          playWalletSound('soft')
        }
      }
      // P2P createAction mutates toolbox outs + remittance metadata — backup BRC-39.
      scheduleHistoryBackupPush('createAction')
    } else if (method === 'signAction') {
      playWalletSound('soft')
      scheduleHistoryBackupPush('signAction')
    } else if (method === 'internalizeAction') {
      if (isItemReceiveArgs(method, args)) {
        paintAfterInternalizeItem(
          active,
          originator ?? WALLET_ACTIVITY_ORIGIN,
          args,
          result,
        )
        playWalletSound('receive')
      } else {
        const sats = extractSatsFromArgs(method, args)
        if (sats > 0) {
          recordAppActivity({
            origin: originator,
            kind: 'earned',
            sats,
            method,
            txid: extractTxid(result) ?? extractTxid(args),
          })
          playWalletSound('receive')
        } else {
          playWalletSound('soft')
        }
      }
      scheduleHistoryBackupPush('internalizeAction')
    } else if (isActionMethod(method)) {
      playWalletSound('soft')
    }

    return { status: 200, body: JSON.stringify(result ?? {}) }
  } catch (error) {
    if (isActionMethod(method)) playWalletSound('error')
    const flat = flattenJsonError(error)
    const code =
      error instanceof MarketListingError
        ? error.code
        : error instanceof IndexManifestError
          ? 'INVALID_INDEX_MANIFEST'
          : flat.code
    return {
      status: 400,
      body: JSON.stringify({
        status: 'error',
        ...(code ? { code } : {}),
        description: flat.description,
      }),
    }
  }
}
