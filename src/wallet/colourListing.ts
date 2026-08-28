/**
 * List 1Sat fungible tips (BRC-175 basket `1sat-ft`).
 */
import { getActiveWallet, type ActiveWallet } from './session'
import {
  aggregateColourTokens,
  colourTokenAsFungible,
  looksLikeOnesatFtTip,
  ONESAT_FT_BASKET,
  originFromColourCi,
  originFromColourTags,
  parseColourMintAttestation,
  parseColourTipAmt,
  tipCountsTowardBalance,
  parseOnesatFtOriginPolicy,
  tryParseProvenanceFromCi,
  verifyColourTipProvenance,
  type ColourOriginMeta,
  type ColourTip,
  type ColourToken,
} from './colourCoins'
import { getTokenIconDataUrl } from './tokenIconCache'
import {
  healOnesatFtFromListed,
  isOnesatFtGenesisSpent,
  spentOnesatFtGenesisOrigins,
  leftoverForOutpoint,
  listOnesatFtLeftovers,
  normOnesatFtOutpoint,
  onesatFtLeftoverAmtInflated,
  shouldOverlayOnesatFtLeftover,
} from './onesatFtLeftover'
import { healMisfiledOnesatFtReceives } from './appActivity'

export type { ColourToken, ColourTip }

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

function hasOnesatFtTag(tags: string[]): boolean {
  return tags.some((t) => String(t).trim().toLowerCase() === '1sat-ft')
}

async function listBasketTips(
  wallet: ActiveWallet,
  basket: string,
  opts: { scripts?: boolean } = {},
): Promise<ListedOutput[]> {
  try {
    const listed = (await wallet.wallet.listOutputs({
      basket,
      limit: 1000,
      ...(opts.scripts === false ? {} : { include: 'locking scripts' }),
      includeCustomInstructions: true,
      includeTags: true,
      seekPermission: false,
    })) as { outputs?: ListedOutput[] }
    return listed.outputs ?? []
  } catch {
    return []
  }
}

function forgetBurnedFungibles(keepOrigins: Iterable<string>): void {
  const keep = new Set(
    [...keepOrigins].map(normOnesatFtOutpoint).filter(Boolean),
  )
  for (const row of listOnesatFtLeftovers()) {
    const origin = normOnesatFtOutpoint(row.origin)
    if (origin) keep.add(origin)
  }
  void import('./fungibles')
    .then(({ forgetFungibleToken }) => {
      for (const origin of spentOnesatFtGenesisOrigins()) {
        if (keep.has(normOnesatFtOutpoint(origin))) continue
        forgetFungibleToken(origin)
      }
    })
    .catch(() => {})
}

export async function listColourTips(
  wallet: ActiveWallet = getActiveWallet()!,
): Promise<ColourTip[]> {
  if (!wallet) return []
  // Tokens live in `1sat-ft` only. Do not scan `1sat` (NFT / BRC-147 auto-sync)
  // or `default` (hangs boot on every BSV UTXO). Leftover change is overlaid
  // from send remittance.
  const rows = [...(await listBasketTips(wallet, ONESAT_FT_BASKET))]
  healOnesatFtFromListed(rows)

  const seen = new Set<string>()
  const pending: Array<{
    outpoint: string
    origin: string
    satoshis: number
    scriptHex?: string
    tags: string[]
    ci?: string
    provenance: ReturnType<typeof tryParseProvenanceFromCi>
  }> = []

  for (const o of rows) {
    const outpoint = typeof o.outpoint === 'string' ? o.outpoint : ''
    if (!outpoint) continue
    const key = normOnesatFtOutpoint(outpoint)
    if (seen.has(key)) continue
    seen.add(key)
    if (isOnesatFtGenesisSpent(key)) continue
    // Do not hide 1sat-ft self-send receives behind collectables sent-guard.
    // Spent leftover outpoints are dropped by leftover heal, not this skip.
    const satoshis = typeof o.satoshis === 'number' ? o.satoshis : 0
    if (satoshis !== 1) continue
    const tags = Array.isArray(o.tags) ? o.tags : []
    const scriptHex = lockingScriptHex(o.lockingScript)
    const listedCi =
      typeof o.customInstructions === 'string' ? o.customInstructions : undefined
    const leftover = leftoverForOutpoint(key)
    const leftoverCi =
      leftover && !onesatFtLeftoverAmtInflated(leftover) ? leftover.ci : undefined
    const listedFt = looksLikeOnesatFtTip({
      tags,
      customInstructions: listedCi,
      lockingScriptHex: scriptHex,
    })
    // Keep a 1-sat output if it has 1sat-ft CI/tags OR leftover remittance.
    if (!listedFt && !hasOnesatFtTag(tags) && !leftover) continue
    // Overlay leftover remittance onto bare P2PKH change so amt is visible.
    const ci =
      looksLikeOnesatFtTip({ customInstructions: listedCi })
        ? listedCi
        : leftoverCi ?? listedCi
    let origin =
      leftover?.origin ??
      originFromColourTags(tags) ??
      originFromColourCi(ci) ??
      parseOnesatFtOriginPolicy(outpointUnderscore(outpoint), {
        lockingScriptHex: scriptHex,
        customInstructions: ci,
        tags,
      }).origin
    if (!leftover && origin) {
      const sameOriginLeftover = listOnesatFtLeftovers().find(
        (row) => normOnesatFtOutpoint(row.origin) === normOnesatFtOutpoint(origin),
      )
      if (sameOriginLeftover?.origin) origin = sameOriginLeftover.origin
    }
    // Spent genesis means the mint UTXO is gone, not leftover change of that origin.
    pending.push({
      outpoint: key,
      origin,
      satoshis,
      scriptHex,
      tags: tags.map(String),
      ci,
      provenance: tryParseProvenanceFromCi(ci),
    })
  }

  for (const leftover of listOnesatFtLeftovers()) {
    const leftoverOp = normOnesatFtOutpoint(leftover.outpoint)
    // Overlay leftover change even when a receive of the same origin is listed.
    // Genesis spent is expected (the mint UTXO moved); do not hide leftover.
    if (!shouldOverlayOnesatFtLeftover(leftover, seen)) continue
    seen.add(leftoverOp)
    pending.push({
      outpoint: leftoverOp,
      origin: leftover.origin,
      satoshis: 1,
      tags: ['1sat-ft'],
      ci: leftover.ci,
      provenance: tryParseProvenanceFromCi(leftover.ci),
    })
  }

  forgetBurnedFungibles(pending.map((row) => row.origin).filter(Boolean))

  // Origin policy: prefer genesis tip's inscription.
  const metaByOrigin = new Map<string, ColourOriginMeta>()
  for (const row of pending) {
    if (row.outpoint !== row.origin) continue
    metaByOrigin.set(
      row.origin,
      parseOnesatFtOriginPolicy(row.origin, {
        lockingScriptHex: row.scriptHex,
        customInstructions: row.ci,
        tags: row.tags,
      }),
    )
  }
  for (const row of pending) {
    if (metaByOrigin.has(row.origin)) continue
    metaByOrigin.set(
      row.origin,
      parseOnesatFtOriginPolicy(row.origin, {
        lockingScriptHex: row.scriptHex,
        customInstructions: row.ci,
        tags: row.tags,
      }),
    )
  }

  // Resolve binding with parent induction (bounded).
  const bound = new Map<string, boolean>()
  const tips: ColourTip[] = []

  const tryBind = (row: (typeof pending)[0], depth: number): boolean => {
    if (bound.has(row.outpoint)) return bound.get(row.outpoint)!
    if (depth > 32) {
      bound.set(row.outpoint, false)
      return false
    }
    const attest = parseColourMintAttestation(row.ci)
    let parentBound: boolean | undefined
    if (attest.parent) {
      const parentRow = pending.find((p) => p.outpoint === attest.parent)
      if (parentRow) parentBound = tryBind(parentRow, depth + 1)
      else parentBound = false
    }
    const check = verifyColourTipProvenance({
      tipOutpoint: row.outpoint,
      claimedOrigin: row.origin,
      provenance: row.provenance,
      lockingScriptHex: row.scriptHex,
      customInstructions: row.ci,
      originMeta: metaByOrigin.get(row.origin),
      parentBound,
    })
    bound.set(row.outpoint, check.ok)
    return check.ok
  }

  for (const row of pending) {
    const proven = tryBind(row, 0)
    const amt = parseColourTipAmt({
      customInstructions: row.ci,
      lockingScriptHex: row.scriptHex,
    })
    tips.push({
      outpoint: row.outpoint,
      origin: row.origin,
      satoshis: row.satoshis,
      amt,
      lockingScript: row.scriptHex,
      provenance: row.provenance ?? undefined,
      proven,
      name: metaByOrigin.get(row.origin)?.name,
      customInstructions: row.ci,
      tags: row.tags,
    })
  }

  healMisfiledOnesatFtReceives(tips.map(tip => ({ outpoint: tip.outpoint, origin: tip.origin, amt: tip.amt, name: tip.name })))

  return tips
}

export async function listColourTokens(
  wallet?: ActiveWallet | null,
): Promise<ColourToken[]> {
  const active = wallet ?? getActiveWallet()
  if (!active) return []
  const tips = await listColourTips(active)
  const metaByOrigin = new Map<string, ColourOriginMeta>()
  for (const tip of tips) {
    if (metaByOrigin.has(tip.origin)) continue
    const genesis = tips.find((t) => t.outpoint === tip.origin)
    metaByOrigin.set(
      tip.origin,
      parseOnesatFtOriginPolicy(tip.origin, {
        lockingScriptHex: genesis?.lockingScript ?? tip.lockingScript,
        customInstructions: genesis?.customInstructions ?? tip.customInstructions,
        tags: genesis?.tags ?? tip.tags,
      }),
    )
  }
  return aggregateColourTokens(tips, metaByOrigin)
}

export async function listColourTokensAsFungibles(
  wallet?: ActiveWallet | null,
): Promise<ReturnType<typeof colourTokenAsFungible>[]> {
  const active = wallet ?? getActiveWallet()
  const tokens = await listColourTokens(active)
  const { resolveOnesatFtIconDataUrl } = await import('./tokenIconResolve')
  const out: ReturnType<typeof colourTokenAsFungible>[] = []
  for (const token of tokens) {
    const realFt = token.supply === 'locked' || token.balance > 1
    let iconUrl =
      token.iconUrl ?? (token.icon ? getTokenIconDataUrl(token.icon) : undefined)
    if (!iconUrl && active && realFt) {
      iconUrl = await resolveOnesatFtIconDataUrl({
        origin: token.origin,
        icon: token.icon,
        tipOutpoint: token.outpoint,
        wallet: active,
      })
    }
    out.push(
      colourTokenAsFungible(
        iconUrl ? { ...token, iconUrl } : token,
      ),
    )
  }
  return out
}

export async function listColourTipsForOrigin(
  origin: string,
  wallet?: ActiveWallet | null,
): Promise<ColourTip[]> {
  const tips = await listColourTips(wallet ?? getActiveWallet()!)
  const want = origin.includes('.')
    ? origin.replace(/\.(\d+)$/, '_$1').toLowerCase()
    : origin.toLowerCase()
  return tips.filter((t) => t.origin === want && tipCountsTowardBalance(t))
}
