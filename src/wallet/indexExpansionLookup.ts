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

function enrichFromMarketContext(
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
  const ctxObj =
    context && typeof context === 'object' && !Array.isArray(context)
      ? (context as Record<string, unknown>)
      : null
  const marketHints = enrichFromMarketContext(outpoint, beefArr, outputIndex)
  return {
    outpoint,
    outputIndex,
    beefB64: bytesToBase64(beefArr),
    context,
    name:
      (typeof ctxObj?.name === 'string' ? ctxObj.name : undefined) ??
      marketHints.name,
    imageUrl: typeof ctxObj?.imageUrl === 'string' ? ctxObj.imageUrl : undefined,
    origin:
      (typeof ctxObj?.origin === 'string' ? ctxObj.origin : undefined) ??
      marketHints.origin ??
      outpoint.replace('_', '.'),
  }
}

/** POST BRC-24 /lookup and map to overlay outputs. */
export async function fetchOverlayLookup(args: {
  manifest: IndexExpansionManifest
  fetchImpl?: typeof fetch
  maxEntries?: number
}): Promise<OverlayLookupResult> {
  const { manifest } = args
  const fetchImpl = args.fetchImpl ?? fetch
  const maxEntries = args.maxEntries ?? manifest.budget.maxEntries
  const url = `${manifest.overlayBaseUrl.replace(/\/+$/, '')}/lookup`
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        service: manifest.lookupService,
        query: manifest.scope.query ?? {},
      }),
    })
  } catch (err) {
    throw new Error(
      err instanceof Error ? err.message : 'Overlay lookup request failed',
    )
  }
  if (!res.ok) {
    throw new Error(`Overlay lookup failed (${res.status})`)
  }
  const json = (await res.json()) as {
    type?: string
    outputs?: LookupAnswerOutput[]
  }
  if (json.type && json.type !== 'output-list') {
    throw new Error(`Unexpected lookup answer type: ${json.type}`)
  }
  const rawOutputs = Array.isArray(json.outputs) ? json.outputs : []
  const mapped: OverlayLookupOutput[] = []
  for (const raw of rawOutputs) {
    if (mapped.length >= maxEntries) {
      return { outputs: mapped, truncated: true }
    }
    const row = mapLookupOutput(raw)
    if (row) mapped.push(row)
  }
  return { outputs: mapped, truncated: false }
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
