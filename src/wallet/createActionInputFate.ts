/**
 * A createAction can sign against local coins an explorer has already confirmed
 * spent. The reply still carries a txid, then the broadcast reject retires that
 * output and the next call (a market list of the mint) finds nothing.
 *
 * Before the app is told the mint exists, name those inputs and sign again.
 */
import { Beef } from '@bsv/sdk'
import type { Chain } from './vault'
import { inputOutpointsFromAtomicBeef } from './txOutpoints'
import { extractTxid } from './txExplorer'
import { parseOutpoint } from './legacyScan'
import {
  coinCleared,
  noteCoinsCleared,
  resetClearedCoinsForTests,
} from './spendCertainty'

export const PROBE_MS = 1_500
/** WhatsOnChain's bulk `/utxos/spent` answers at most this many per request. */
export const SPENT_PROBE_BATCH = 20
/** Teranode's bulk `/utxos` takes 36-byte records; keep one request small. */
export const TERANODE_PROBE_BATCH = 100

/**
 * `spent` names the transaction a node or explorer holds as the spender;
 * `unspent` is a positive answer that nothing does. Anything else — silence,
 * a rate limit, an output the source does not know — is `unknown`.
 */
export type OutpointSpendProbe =
  | { kind: 'unspent' }
  | { kind: 'spent'; spender: string }
  | { kind: 'unknown' }

const UNKNOWN: OutpointSpendProbe = { kind: 'unknown' }

/**
 * Teranode asset services from Arcade's `/health` datahub list that answer
 * the bulk spend lookup over HTTPS with CORS. A node sees mempool spenders
 * as well as mined ones; WhatsOnChain names only confirmed spenders.
 */
const TERANODE_UTXO_HOSTS: Record<Chain, readonly string[]> = {
  main: ['https://mainnet.gorillanode.io/api/v1', 'https://mainnet2.gorillanode.io/api/v1'],
  test: [],
}

/** `utxo.Status` in Teranode's store. */
const TERANODE_UTXO_OK = 0
const TERANODE_UTXO_SPENT = 1

function wocBulkSpentUrl(chain: Chain): string {
  const host =
    chain === 'main'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test'
  return `${host}/utxos/spent`
}

/** An explorer cleared it and this wallet has not signed over it since. */
export function outpointRecentlyCleared(outpoint: string): boolean {
  return coinCleared(outpoint)
}

export function resetClearedOutpointsForTests(): void {
  resetClearedCoinsForTests()
}

/** WhatsOnChain `/spent` body → a confirmed spender that is not this tx. */
export function parseConfirmedForeignSpender(
  body: unknown,
  selfTxid: string,
): string | null {
  if (!body || typeof body !== 'object') return null
  const row = body as { txid?: unknown; status?: unknown }
  if (String(row.status ?? '').trim().toLowerCase() !== 'confirmed') return null
  const spender = String(row.txid ?? '').trim().toLowerCase()
  const self = selfTxid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(spender) || spender === self) return null
  return spender
}

/**
 * One entry of the bulk `/utxos/spent` reply. An entry with no `spentIn` and
 * no error is the unspent answer (the per-outpoint endpoint's 404); an unknown
 * output carries `spentIn.status: "Unknown UTXO"` and stays `unknown`.
 */
export function parseBulkSpentEntry(entry: unknown, selfTxid: string): OutpointSpendProbe {
  if (!entry || typeof entry !== 'object') return UNKNOWN
  const row = entry as { error?: unknown; spentIn?: unknown }
  if (String(row.error ?? '').trim()) return UNKNOWN
  if (row.spentIn == null) return { kind: 'unspent' }
  const spender = parseConfirmedForeignSpender(row.spentIn, selfTxid)
  return spender ? { kind: 'spent', spender } : UNKNOWN
}

/**
 * One record of Teranode's bulk `/utxos/json` reply. `NOT_FOUND` is not an
 * answer: the node drops a transaction once every output is spent and mined
 * past its retention, and it reads the same for an output it never saw.
 */
export function parseTeranodeUtxoEntry(entry: unknown, selfTxid: string): OutpointSpendProbe {
  if (!entry || typeof entry !== 'object') return UNKNOWN
  const row = entry as { status?: unknown; spendingData?: { txId?: unknown } | null }
  if (row.status === TERANODE_UTXO_OK) return { kind: 'unspent' }
  if (row.status !== TERANODE_UTXO_SPENT) return UNKNOWN
  const spender = String(row.spendingData?.txId ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(spender) || spender === selfTxid.trim().toLowerCase()) return UNKNOWN
  return { kind: 'spent', spender }
}

/** A named spender from any source outranks an unspent answer from another. */
export function combineSpendProbes(
  a: OutpointSpendProbe | undefined,
  b: OutpointSpendProbe | undefined,
): OutpointSpendProbe {
  if (a?.kind === 'spent') return a
  if (b?.kind === 'spent') return b
  if (a?.kind === 'unspent' || b?.kind === 'unspent') return { kind: 'unspent' }
  return UNKNOWN
}

type ParsedOutpoint = { outpoint: string; key: string; txid: string; vout: number }

/** `[txid, internal byte order][vout, u32 LE]` per outpoint. */
export function teranodeUtxoRequestBody(
  outpoints: Array<{ txid: string; vout: number }>,
): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(outpoints.length * 36)
  const view = new DataView(body.buffer)
  outpoints.forEach(({ txid, vout }, i) => {
    const at = i * 36
    for (let b = 0; b < 32; b++) body[at + b] = parseInt(txid.slice(62 - b * 2, 64 - b * 2), 16)
    view.setUint32(at + 32, vout, true)
  })
  return body
}

async function teranodeSpent(
  chunk: ParsedOutpoint[],
  selfTxid: string,
  chain: Chain,
  deadline: number,
): Promise<Map<string, OutpointSpendProbe>> {
  const answers = new Map<string, OutpointSpendProbe>()
  for (const host of TERANODE_UTXO_HOSTS[chain]) {
    const left = deadline - Date.now()
    if (left <= 0) break
    try {
      const res = await fetch(`${host}/utxos/json`, {
        method: 'POST',
        signal: AbortSignal.timeout(left),
        headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' },
        body: teranodeUtxoRequestBody(chunk),
      })
      if (!res.ok) continue
      const body: unknown = await res.json()
      if (!Array.isArray(body) || body.length !== chunk.length) continue
      chunk.forEach((row, i) => answers.set(row.key, parseTeranodeUtxoEntry(body[i], selfTxid)))
      return answers
    } catch {
      // Timeout or network: try the next node inside the same budget.
    }
  }
  return answers
}

async function bulkSpent(
  chunk: ParsedOutpoint[],
  selfTxid: string,
  chain: Chain,
  timeoutMs: number,
): Promise<Map<string, OutpointSpendProbe>> {
  const answers = new Map<string, OutpointSpendProbe>()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(wocBulkSpentUrl(chain), {
      method: 'POST',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ utxos: chunk.map(({ txid, vout }) => ({ txid, vout })) }),
    })
    if (!res.ok) return answers
    const body: unknown = await res.json()
    if (!Array.isArray(body)) return answers
    for (const entry of body) {
      const utxo = (entry as { utxo?: { txid?: unknown; vout?: unknown } } | null)?.utxo
      const txid = String(utxo?.txid ?? '').trim().toLowerCase()
      const vout = Number(utxo?.vout)
      if (!txid || !Number.isInteger(vout)) continue
      answers.set(`${txid}.${vout}`, parseBulkSpentEntry(entry, selfTxid))
    }
  } catch {
    // Timeout or network: every outpoint in the chunk stays unknown.
  } finally {
    clearTimeout(timer)
  }
  return answers
}

async function explorerSpent(
  parsed: ParsedOutpoint[],
  selfTxid: string,
  chain: Chain,
  timeoutMs: number,
): Promise<Map<string, OutpointSpendProbe>> {
  const answers = new Map<string, OutpointSpendProbe>()
  for (let i = 0; i < parsed.length; i += SPENT_PROBE_BATCH) {
    const chunk = parsed.slice(i, i + SPENT_PROBE_BATCH)
    for (const [key, probe] of await bulkSpent(chunk, selfTxid, chain, timeoutMs)) {
      answers.set(key, probe)
    }
  }
  return answers
}

async function nodeSpent(
  parsed: ParsedOutpoint[],
  selfTxid: string,
  chain: Chain,
  timeoutMs: number,
): Promise<Map<string, OutpointSpendProbe>> {
  const answers = new Map<string, OutpointSpendProbe>()
  const deadline = Date.now() + timeoutMs
  for (let i = 0; i < parsed.length; i += TERANODE_PROBE_BATCH) {
    const chunk = parsed.slice(i, i + TERANODE_PROBE_BATCH)
    for (const [key, probe] of await teranodeSpent(chunk, selfTxid, chain, deadline)) {
      answers.set(key, probe)
    }
  }
  return answers
}

/**
 * Ask a Teranode node and WhatsOnChain, together, who spent each outpoint.
 * A spender either names wins; otherwise an unspent answer from either
 * clears the coin. Silence from both stays `unknown`.
 */
export async function probeOutpointSpends(
  outpoints: string[],
  selfTxid: string,
  chain: Chain,
  timeoutMs = PROBE_MS,
): Promise<Map<string, OutpointSpendProbe>> {
  const probes = new Map<string, OutpointSpendProbe>()
  const parsed: ParsedOutpoint[] = []
  for (const outpoint of outpoints) {
    const p = parseOutpoint(outpoint)
    if (!p) {
      probes.set(outpoint, UNKNOWN)
      continue
    }
    const txid = p.txid.toLowerCase()
    parsed.push({ outpoint, key: `${txid}.${p.vout}`, txid, vout: p.vout })
  }
  const [node, explorer] = await Promise.all([
    nodeSpent(parsed, selfTxid, chain, timeoutMs),
    explorerSpent(parsed, selfTxid, chain, timeoutMs),
  ])
  const cleared: string[] = []
  for (const row of parsed) {
    const probe = combineSpendProbes(node.get(row.key), explorer.get(row.key))
    if (probe.kind === 'unspent') cleared.push(row.outpoint)
    probes.set(row.outpoint, probe)
  }
  if (cleared.length > 0) noteCoinsCleared(cleared)
  return probes
}

export function atomicFromCreateResult(result: unknown): number[] | null {
  if (!result || typeof result !== 'object') return null
  const raw = (result as { tx?: unknown }).tx
  if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
    return raw as number[]
  }
  if (raw instanceof Uint8Array) return Array.from(raw)
  return null
}

/**
 * Inputs whose parent may be mined. A confirmed spender needs a confirmed
 * parent, so an input whose parent rides this BEEF as a raw tx with no proof
 * cannot have one — back-to-back payments spend exactly that unmined change.
 * A parent the BEEF names by txid only, or omits, is still probed.
 */
export function inputsWithPossiblyMinedParent(atomic: number[], txid: string): string[] {
  const inputs = inputOutpointsFromAtomicBeef(atomic, txid)
  let beef: Beef
  try {
    beef = Beef.fromBinary(atomic)
  } catch {
    return inputs
  }
  return inputs.filter((outpoint) => {
    const parent = beef.findTxid(outpoint.split('.')[0] ?? '')
    return !parent || parent.isTxidOnly || parent.hasProof
  })
}

export async function foreignConfirmedInputSpends(
  result: unknown,
  chain: Chain,
): Promise<Array<{ outpoint: string; spender: string }>> {
  const txid = extractTxid(result)?.toLowerCase()
  const atomic = atomicFromCreateResult(result)
  if (!txid || !atomic?.length) return []
  const inputs = inputsWithPossiblyMinedParent(atomic, txid).filter(
    (outpoint) => !outpointRecentlyCleared(outpoint),
  )
  if (inputs.length === 0) return []
  const started = Date.now()
  const probes = await probeOutpointSpends(inputs, txid, chain)
  const ms = Date.now() - started
  if (ms >= 250) console.info(`[spend] input_fate done ${ms}ms`)
  return inputs.flatMap((outpoint) => {
    const probe = probes.get(outpoint)
    return probe?.kind === 'spent' ? [{ outpoint, spender: probe.spender }] : []
  })
}

/**
 * Hide coins a confirmed foreign tx already spent, and retire this signed tx
 * so its outputs are not listed as held. Returns true when a resign is required.
 *
 * One dead coin means the pool holds more, so the rest are swept in the
 * background instead of one resign per payment finding them. Each spender is
 * adopted there too: when it is this wallet's own send failed locally, its
 * change comes back instead of vanishing with the hidden input.
 */
export async function retireCreateActionSpentElsewhere(
  result: unknown,
  chain: Chain,
  opts?: { freshlySigned?: boolean },
): Promise<boolean> {
  const txid = extractTxid(result)?.toLowerCase()
  if (!txid) return false
  const spends = await foreignConfirmedInputSpends(result, chain)
  if (spends.length === 0) return false
  await retireSpentInputs(txid, spends, chain, opts)
  return true
}

/**
 * Retire a signed tx over coins a named confirmed tx already spent: fail it,
 * then hide each dead coin under its spender and sweep the rest of the pool.
 */
export async function retireSpentInputs(
  txid: string,
  spends: Array<{ outpoint: string; spender: string }>,
  chain: Chain,
  opts?: { freshlySigned?: boolean },
): Promise<void> {
  const started = Date.now()
  const bySpender = new Map<string, string[]>()
  for (const row of spends) {
    const list = bySpender.get(row.spender) ?? []
    list.push(row.outpoint)
    bySpender.set(row.spender, list)
  }
  const { hideSpentOutpoints, failUnsentLocalTx } = await import(
    './staleOutputRelease'
  )
  // Failing a tx restores its inputs to spendable, so fail first: hiding
  // first had the fail hand the dead coins straight back to the next sign.
  await failUnsentLocalTx(txid, {
    force: true,
    noDescendants: opts?.freshlySigned === true,
  })
  const failedAt = Date.now()
  for (const [spender, outpoints] of bySpender) {
    await hideSpentOutpoints(outpoints, spender)
  }
  const ms = Date.now() - started
  if (ms >= 250) {
    console.info(
      `[spend] retire done ${ms}ms fail=${failedAt - started}ms hide=${Date.now() - failedAt}ms`,
    )
  }
  console.warn(
    `[spend] ${txid.slice(0, 12)} inputs spent elsewhere count=${spends.length} — ${spends
      .slice(0, 6)
      .map((s) => `${s.outpoint} by ${s.spender.slice(0, 12)}`)
      .join(', ')}`,
  )
  void import('./deadCoinSweep').then(({ scheduleDeadCoinSweep }) =>
    scheduleDeadCoinSweep(chain, bySpender.keys()),
  )
}
