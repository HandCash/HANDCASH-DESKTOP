import {
  overlayRequestFromManifest,
  queryOverlayWithFailover,
  type OverlayLookupRequest,
  type RawLookupAnswer,
} from './overlayClient'
import { Beef } from '@bsv/sdk'
import { parseMarketOffer } from './marketOverlayProtocol'
import type { IndexEntryCustomInstructions } from './indexExpansionTypes'
import type { IndexExpansionManifest } from './indexExpansionTypes'
import { buildIndexEntryRecord } from './indexExpansionStore'

export type OverlayLookupOutput = {
  outpoint: string
  outputIndex: number
  beefB64?: string
  context?: unknown
  name?: string
  imageUrl?: string
  origin?: string
}

export type OverlayLookupResult = {
  outputs: OverlayLookupOutput[]
  truncated: boolean
  host?: string
  hostsTried?: string[]
}

export type LiveOverlayLookupArgs = {
  lookupService: string
  query?: Record<string, unknown>
  overlayBaseUrl?: string
  discovery?: OverlayLookupRequest['discovery']
  slapTrackers?: string[]
  extraHosts?: string[]
  maxOutputs?: number
}

type LookupAnswerOutput = {
  beef?: number[] | Uint8Array
  outputIndex?: number
  context?: number[] | Uint8Array | string
}

function bytesToBase64(bytes: number[] | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)
  let binary = ''
  for (const byte of arr) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeContext(context: unknown): unknown {
  if (context == null) return undefined
  if (typeof context === 'string') {
    try {
      return JSON.parse(context)
    } catch {
      return context
    }
  }
  if (Array.isArray(context) || context instanceof Uint8Array) {
    const bytes = context instanceof Uint8Array ? context : Uint8Array.from(context)
    try {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      try {
        return JSON.parse(text)
      } catch {
        return text.trim() || undefined
      }
    } catch {
      return undefined
    }
  }
  return context
}

function displayFromContext(context: unknown): Pick<OverlayLookupOutput, 'name' | 'imageUrl' | 'origin'> {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return {}
  const ctx = context as Record<string, unknown>
  const provenance =
    ctx.provenance && typeof ctx.provenance === 'object'
      ? (ctx.provenance as Record<string, unknown>)
      : null
  const name =
    (typeof ctx.name === 'string' ? ctx.name : undefined) ??
    (typeof provenance?.name === 'string' ? provenance.name : undefined) ??
    (typeof ctx.sym === 'string' ? ctx.sym : undefined) ??
    (typeof provenance?.sym === 'string' ? provenance.sym : undefined)
  const imageUrl =
    (typeof ctx.imageUrl === 'string' ? ctx.imageUrl : undefined) ??
    (typeof ctx.image === 'string' ? ctx.image : undefined) ??
    (typeof provenance?.imageUrl === 'string' ? provenance.imageUrl : undefined)
  const origin =
    (typeof ctx.origin === 'string' ? ctx.origin : undefined) ??
    (typeof ctx.itemOutpoint === 'string' ? ctx.itemOutpoint : undefined) ??
    (typeof provenance?.origin === 'string' ? provenance.origin : undefined)
  return {
    ...(name ? { name } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    ...(origin ? { origin: origin.replace('.', '_') } : {}),
  }
}

function outpointFromBeef(beefBytes: number[] | Uint8Array, outputIndex: number): string | null {
  try {
    const beef = Beef.fromBinary(
      beefBytes instanceof Uint8Array ? Array.from(beefBytes) : beefBytes,
    )
    const txs = beef.txs ?? []
    for (const entry of txs) {
      const tx = entry.tx
      if (!tx?.id) continue
      const vout = Number.isInteger(outputIndex) ? outputIndex : 0
      return `${tx.id}_${vout}`
    }
  } catch {
    return null
  }
  return null
}

function enrichFromMarketScript(
  outpoint: string,
  beefBytes: number[] | Uint8Array | undefined,
  outputIndex: number,
): Pick<OverlayLookupOutput, 'name' | 'origin'> {
  if (!beefBytes) return {}
  try {
    const beef = Beef.fromBinary(
      beefBytes instanceof Uint8Array ? Array.from(beefBytes) : beefBytes,
    )
    const txEntry = beef.findTxid(outpoint.split('_')[0] ?? '')
    const tx = txEntry?.tx
    if (!tx) return {}
    const output = tx.outputs[outputIndex]
    if (!output?.lockingScript) return {}
    const offer = parseMarketOffer(output.lockingScript.toHex())
    if (!offer) return {}
    return {
      name: `Listing ${offer.grossPriceSats} sats`,
      origin: outpoint.replace('_', '.'),
    }
  } catch {
    return {}
  }
}

function mapLookupOutput(raw: LookupAnswerOutput): OverlayLookupOutput | null {
  const outputIndex = raw.outputIndex ?? 0
  const beefArr = raw.beef
  if (!beefArr || (Array.isArray(beefArr) && beefArr.length === 0)) return null
  const outpoint = outpointFromBeef(beefArr, outputIndex)
  if (!outpoint) return null
  const context = decodeContext(raw.context)
  const fromContext = displayFromContext(context)
  const marketHints = enrichFromMarketScript(outpoint, beefArr, outputIndex)
  return {
    outpoint,
    outputIndex,
    beefB64: bytesToBase64(beefArr),
    context,
    name: fromContext.name ?? marketHints.name,
    imageUrl: fromContext.imageUrl,
    origin: fromContext.origin ?? marketHints.origin ?? outpoint.replace('_', '.'),
  }
}

function mapRawAnswer(answer: RawLookupAnswer, maxEntries: number): OverlayLookupResult {
  const rawOutputs = Array.isArray(answer.outputs) ? answer.outputs : []
  const mapped: OverlayLookupOutput[] = []
  for (const raw of rawOutputs) {
    if (mapped.length >= maxEntries) {
      return { outputs: mapped, truncated: true }
    }
    const row = mapLookupOutput(raw as LookupAnswerOutput)
    if (row) mapped.push(row)
  }
  return { outputs: mapped, truncated: false }
}

/** Live BRC-24 lookup — authoritative overlay read, no local cache. */
export async function liveOverlayLookup(
  args: LiveOverlayLookupArgs,
  fetchImpl?: typeof fetch,
): Promise<OverlayLookupResult & { type: 'output-list' }> {
  const maxEntries = Math.max(1, Math.min(args.maxOutputs ?? 500, 5000))
  const { answer, host, hostsTried } = await queryOverlayWithFailover(
    {
      lookupService: args.lookupService,
      query: args.query ?? {},
      overlayBaseUrl: args.overlayBaseUrl,
      discovery: args.discovery ?? 'auto',
      slapTrackers: args.slapTrackers,
      extraHosts: args.extraHosts,
    },
    fetchImpl,
  )
  const mapped = mapRawAnswer(answer, maxEntries)
  return { type: 'output-list', ...mapped, host, hostsTried }
}

/** Pack sync: SLAP discovery + multi-host BRC-24 lookup. */
export async function fetchOverlayLookup(args: {
  manifest: IndexExpansionManifest
  fetchImpl?: typeof fetch
  maxEntries?: number
}): Promise<OverlayLookupResult> {
  const maxEntries = args.maxEntries ?? args.manifest.budget.maxEntries
  const { answer, host, hostsTried } = await queryOverlayWithFailover(
    overlayRequestFromManifest(args.manifest),
    args.fetchImpl,
  )
  const mapped = mapRawAnswer(answer, maxEntries)
  return { ...mapped, host, hostsTried }
}

export function overlayOutputsToListOutputs(
  outputs: OverlayLookupOutput[],
  packId?: string,
): { outputs: Record<string, unknown>[]; totalOutputs: number } {
  const list = outputs.map((out, index) => {
    const entryKey = packId
      ? `listing:${out.outpoint.replace('.', '_')}`
      : `row:${index}`
    const ci: IndexEntryCustomInstructions = {
      packId: packId ?? 'live',
      entryKey,
      name: out.name ?? entryKey,
      ...(out.imageUrl ? { imageUrl: out.imageUrl } : {}),
      origin: out.origin ?? out.outpoint.replace('_', '.'),
      overlayOutpoint: out.outpoint.replace('.', '_'),
      ...(out.beefB64 ? { beefB64: out.beefB64 } : {}),
      updatedAt: Math.floor(Date.now() / 1000),
    }
    if (packId) {
      const row = buildIndexEntryRecord({
        packId,
        entryKey,
        overlayOutpoint: out.outpoint,
        ci,
      })
      return {
        outpoint: row.outpoint,
        basket: 'index',
        satoshis: 0,
        tags: row.tags,
        customInstructions: row.customInstructions,
      }
    }
    return {
      outpoint: out.outpoint.replace('_', '.'),
      basket: 'index',
      satoshis: 0,
      tags: [`entry:${entryKey}`],
      customInstructions: JSON.stringify(ci),
    }
  })
  return { outputs: list, totalOutputs: list.length }
}

export function overlayOutputsToIndexEntries(args: {
  packId: string
  outputs: OverlayLookupOutput[]
  budget: IndexExpansionManifest['budget']
  beefBytesUsed: number
}): {
  rows: ReturnType<typeof buildIndexEntryRecord>[]
  partial: boolean
  beefBytesUsed: number
} {
  const rows: ReturnType<typeof buildIndexEntryRecord>[] = []
  let beefUsed = args.beefBytesUsed
  let partial = false
  for (const out of args.outputs) {
    if (rows.length >= args.budget.maxEntries) {
      partial = true
      break
    }
    const beefLen = out.beefB64 ? Math.ceil((out.beefB64.length * 3) / 4) : 0
    if (beefUsed + beefLen > args.budget.maxBeefBytes) {
      partial = true
      break
    }
    beefUsed += beefLen
    const entryKey = `listing:${out.outpoint.replace('.', '_')}`
    const ci: IndexEntryCustomInstructions = {
      packId: args.packId,
      entryKey,
      name: out.name ?? entryKey,
      ...(out.imageUrl ? { imageUrl: out.imageUrl } : {}),
      origin: out.origin ?? out.outpoint.replace('_', '.'),
      overlayOutpoint: out.outpoint.replace('.', '_'),
      ...(out.beefB64 ? { beefB64: out.beefB64 } : {}),
      updatedAt: Math.floor(Date.now() / 1000),
    }
    const row = buildIndexEntryRecord({
      packId: args.packId,
      entryKey,
      overlayOutpoint: out.outpoint,
      ci,
    })
    if (row.bytes > args.budget.maxBytes) {
      partial = true
      break
    }
    rows.push(row)
  }
  return { rows, partial, beefBytesUsed: beefUsed }
}
