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

const PROBE_MS = 1_500
/**
 * A confirmed foreign spend needs a new block and a key holder other than this
 * device, so a coin the explorer cleared minutes ago is not re-asked per sign.
 */
const CLEARED_TTL_MS = 10 * 60_000

export type OutpointSpendProbe =
  | { kind: 'noConfirmedSpender' }
  | { kind: 'confirmedSpender'; spender: string }
  | { kind: 'unknown' }

const clearedAt = new Map<string, number>()

function wocSpentUrl(chain: Chain, txid: string, vout: number): string {
  const host =
    chain === 'main'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test'
  return `${host}/tx/${txid}/${vout}/spent`
}

function outpointKey(outpoint: string): string {
  return outpoint.trim().toLowerCase()
}

export function outpointRecentlyCleared(outpoint: string, now = Date.now()): boolean {
  const key = outpointKey(outpoint)
  const at = clearedAt.get(key)
  if (at == null) return false
  if (now - at < CLEARED_TTL_MS) return true
  clearedAt.delete(key)
  return false
}

function markCleared(outpoint: string): void {
  clearedAt.set(outpointKey(outpoint), Date.now())
}

export function resetClearedOutpointsForTests(): void {
  clearedAt.clear()
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
 * Ask the explorer who spent `outpoint`. A 404 is the only answer that clears
 * the coin; a timeout, rate limit or unconfirmed spender stays `unknown`.
 */
export async function probeOutpointSpend(
  outpoint: string,
  selfTxid: string,
  chain: Chain,
): Promise<OutpointSpendProbe> {
  const parsed = parseOutpoint(outpoint)
  if (!parsed) return { kind: 'unknown' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_MS)
  try {
    const res = await fetch(wocSpentUrl(chain, parsed.txid, parsed.vout), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (res.status === 404) {
      markCleared(outpoint)
      return { kind: 'noConfirmedSpender' }
    }
    if (!res.ok) return { kind: 'unknown' }
    const spender = parseConfirmedForeignSpender(await res.json(), selfTxid)
    return spender ? { kind: 'confirmedSpender', spender } : { kind: 'unknown' }
  } catch {
    return { kind: 'unknown' }
  } finally {
    clearTimeout(timer)
  }
}

export async function confirmedForeignSpenderTxid(
  outpoint: string,
  selfTxid: string,
  chain: Chain,
): Promise<string | null> {
  const probe = await probeOutpointSpend(outpoint, selfTxid, chain)
  return probe.kind === 'confirmedSpender' ? probe.spender : null
}

function atomicFromCreateResult(result: unknown): number[] | null {
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
  const rows = await Promise.all(
    inputs.map(async (outpoint) => ({
      outpoint,
      spender: await confirmedForeignSpenderTxid(outpoint, txid, chain),
    })),
  )
  const ms = Date.now() - started
  if (ms >= 250) console.info(`[spend] input_fate done ${ms}ms`)
  return rows.filter(
    (row): row is { outpoint: string; spender: string } => row.spender != null,
  )
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
  for (const [spender, outpoints] of bySpender) {
    await hideSpentOutpoints(outpoints, spender)
  }
  const ms = Date.now() - started
  if (ms >= 250) console.info(`[spend] retire done ${ms}ms`)
  console.warn(
    `[brc100] createAction inputs spent elsewhere count=${spends.length} txid=${txid.slice(0, 12)}`,
  )
  void import('./deadCoinSweep').then(({ scheduleDeadCoinSweep }) =>
    scheduleDeadCoinSweep(chain, bySpender.keys()),
  )
  return true
}
