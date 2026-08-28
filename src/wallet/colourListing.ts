/**
 * List 1Sat fungible tips (BRC-175 basket `1sat-ft`).
 */
import { getActiveWallet, type ActiveWallet } from './session'
import {
  aggregateColourTokens,
  colourTokenAsFungible,
  looksLikeOnesatFtTip,
  ONESAT_FT_BASKET,
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
import { isItemSent } from './sentItemGuard'
import { getTokenIconDataUrl } from './tokenIconCache'

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

async function listBasketTips(
  wallet: ActiveWallet,
  basket: string,
): Promise<ListedOutput[]> {
  try {
    const listed = (await wallet.wallet.listOutputs({
      basket,
      limit: 1000,
      include: 'locking scripts',
      includeCustomInstructions: true,
      includeTags: true,
      seekPermission: false,
    })) as { outputs?: ListedOutput[] }
    return listed.outputs ?? []
  } catch {
    return []
  }
}

export async function listColourTips(
  wallet: ActiveWallet = getActiveWallet()!,
): Promise<ColourTip[]> {
  if (!wallet) return []
  const rows = await listBasketTips(wallet, ONESAT_FT_BASKET)

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
    const key = outpointUnderscore(outpoint).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (isItemSent(key)) continue
    const satoshis = typeof o.satoshis === 'number' ? o.satoshis : 0
    if (satoshis !== 1) continue
    const tags = Array.isArray(o.tags) ? o.tags : []
    const scriptHex = lockingScriptHex(o.lockingScript)
    const ci =
      typeof o.customInstructions === 'string' ? o.customInstructions : undefined
    if (
      !looksLikeOnesatFtTip({
        tags,
        customInstructions: ci,
        lockingScriptHex: scriptHex,
      })
    ) {
      continue
    }
    const origin =
      originFromColourTags(tags) ??
      parseOnesatFtOriginPolicy(outpointUnderscore(outpoint), {
        lockingScriptHex: scriptHex,
        customInstructions: ci,
      }).origin
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

  // Origin policy: prefer genesis tip's inscription.
  const metaByOrigin = new Map<string, ColourOriginMeta>()
  for (const row of pending) {
    if (row.outpoint !== row.origin) continue
    metaByOrigin.set(
      row.origin,
      parseOnesatFtOriginPolicy(row.origin, {
        lockingScriptHex: row.scriptHex,
        customInstructions: row.ci,
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
    })
  }

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
