/**
 * List fungible tips. Tokens are BRC-162 value tips in basket `bsv21` (BRC-163).
 * 1sat-ft leftover overlay and basket `1sat-ft` are not Tokens.
 */
import { getActiveWallet, type ActiveWallet } from './session'
import {
  aggregateFungibles,
  BSV21_BASKET,
  issuerFromRemittance,
  issuerFromSigmaLockingScript,
  normalizeTokenId,
  parseBsv21CustomInstructions,
  type Bsv21Op,
  type Bsv21Utxo,
} from './bsv21'
import { decodeBsv21Binary, iconOutpointFromPayload } from './bsv21Binary'
import { tipFromBsv21Script } from './bsv21Send'
import {
  looksLikeOnesatFtTip,
  type ColourTip,
  type ColourToken,
} from './colourCoins'

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

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
  if (!tags) return undefined
  for (const tag of tags) {
    if (tag.startsWith(prefix)) {
      const v = tag.slice(prefix.length).trim()
      if (v) return v
    }
  }
  return undefined
}

/**
 * Decode a listed basket row as BRC-162 / BRC-163.
 * Script amount wins. CI/tags supply id, dec, sym. 1sat-ft leftovers return null.
 */
export function decodeListedBsv21Tip(raw: ListedOutput, identityKey?: string): Bsv21Utxo | null {
  const outpointRaw = (raw.outpoint ?? '').trim()
  if (!outpointRaw) return null
  const satoshis = typeof raw.satoshis === 'number' ? raw.satoshis : 1
  if (satoshis !== 1) return null
  const scriptHex = lockingScriptHex(raw.lockingScript)
  if (!scriptHex) return null
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : []
  if (
    looksLikeOnesatFtTip({
      tags,
      customInstructions: raw.customInstructions,
      lockingScriptHex: scriptHex,
    })
  ) {
    return null
  }

  const decoded = decodeBsv21Binary(scriptHex)
  if (!decoded) return null
  const fromScript = tipFromBsv21Script({
    outpoint: outpointRaw,
    lockingScript: scriptHex,
    satoshis,
    customInstructions: raw.customInstructions,
    tags,
  })
  if (!fromScript) return null
  const fromCi = parseBsv21CustomInstructions(raw.customInstructions)
  const tokenId = fromScript.tokenId
  const amt = fromScript.amt.toString()
  if (!tokenId || !amt) return null
  const op = (
    decoded?.role === 'deploy' || fromCi?.op === 'deploy+mint'
      ? 'deploy+mint'
      : (fromCi?.op ?? 'transfer')
  ) as Bsv21Op
  const sym = fromCi?.sym ?? decoded?.payload?.sym ?? tagValue(tags, 'sym:')
  const dec = fromCi?.dec ?? decoded?.payload?.dec ?? 0
  const icon =
    iconOutpointFromPayload(decoded.payload?.icon, tokenId) ?? fromCi?.icon
  const maxN = Number(amt)
  const colourMaxSupply =
    op === 'deploy+mint' && Number.isSafeInteger(maxN) && maxN > 0 ? maxN : undefined
  const remittanceIssuer = issuerFromRemittance({
    customInstructions: raw.customInstructions,
    tags,
  })
  const sigma = issuerFromSigmaLockingScript(
    scriptHex,
    [remittanceIssuer, identityKey].filter(Boolean) as string[],
  )
  const issuer = sigma.issuer ?? remittanceIssuer
  return {
    outpoint: outpointUnderscore(outpointRaw).toLowerCase(),
    tokenId,
    amt,
    op,
    dec,
    satoshis: 1,
    colourSupply: 'locked',
    ...(sym ? { sym } : {}),
    ...(icon ? { icon } : {}),
    ...(colourMaxSupply != null ? { colourMaxSupply } : {}),
    ...(scriptHex ? { lockingScript: scriptHex } : {}),
    ...(issuer ? { issuer } : {}),
    ...(sigma.issuer ? { issuerAttested: true } : {}),
  }
}

export async function listBsv21BinaryTips(
  wallet: ActiveWallet,
): Promise<Bsv21Utxo[]> {
  const rows = await listBasketTips(wallet, BSV21_BASKET)
  const tips: Bsv21Utxo[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const tip = decodeListedBsv21Tip(row, wallet.identityKey)
    if (!tip) continue
    if (seen.has(tip.outpoint)) continue
    seen.add(tip.outpoint)
    tips.push(tip)
  }
  return tips
}

export async function listBsv21BinaryTokens(
  wallet?: ActiveWallet | null,
): Promise<ReturnType<typeof aggregateFungibles>> {
  const active = wallet ?? getActiveWallet()
  if (!active) return []
  return aggregateFungibles(await listBsv21BinaryTips(active))
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


function colourTipFromBsv21(tip: Bsv21Utxo): ColourTip | null {
  const amt = Number(String(tip.amt).replace(/\D/g, '') || '0')
  if (!(amt > 0)) return null
  return {
    outpoint: tip.outpoint,
    origin: tip.tokenId,
    satoshis: 1,
    amt,
    proven: true,
    lockingScript: tip.lockingScript,
  }
}

/** 162 / basket `bsv21` only. Does not overlay leftover 1sat-ft. */
export async function listColourTips(
  wallet: ActiveWallet = getActiveWallet()!,
): Promise<ColourTip[]> {
  if (!wallet) return []
  const tips: ColourTip[] = []
  for (const tip of await listBsv21BinaryTips(wallet)) {
    const colour = colourTipFromBsv21(tip)
    if (colour) tips.push(colour)
  }
  return tips
}

export async function listColourTokens(
  wallet?: ActiveWallet | null,
): Promise<ColourToken[]> {
  const tokens = await listBsv21BinaryTokens(wallet)
  return tokens.map((t) => ({
    origin: t.tokenId,
    sym: t.sym || 'Token',
    tipCount: t.utxoCount,
    balance: Number(String(t.amt).replace(/\D/g, '') || '0'),
    supply: (t.colourSupply === 'open' ? 'open' : 'locked') as 'locked' | 'open',
    maxSupply: t.colourMaxSupply ?? null,
    provenanceOk: true,
    outpoint: t.outpoint,
    ...(t.icon ? { icon: t.icon } : {}),
    ...(t.iconUrl ? { iconUrl: t.iconUrl } : {}),
    ...(t.issuer ? { issuer: t.issuer } : {}),
  }))
}

export async function listColourTokensAsFungibles(
  wallet?: ActiveWallet | null,
): Promise<ReturnType<typeof aggregateFungibles>> {
  return listBsv21BinaryTokens(wallet)
}

export async function listColourTipsForOrigin(
  origin: string,
  wallet?: ActiveWallet | null,
): Promise<ColourTip[]> {
  const tips = await listColourTips(wallet ?? getActiveWallet()!)
  const want =
    normalizeTokenId(origin) ??
    (origin.includes('.')
      ? origin.replace(/\.(\d+)$/, '_$1').toLowerCase()
      : origin.toLowerCase())
  return tips.filter((t) => t.origin === want && t.satoshis === 1 && t.amt > 0)
}
