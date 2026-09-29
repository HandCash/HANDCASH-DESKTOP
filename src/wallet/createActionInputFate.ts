/**
 * A createAction can sign against local coins an explorer has already confirmed
 * spent. The reply still carries a txid, then the broadcast reject retires that
 * output and the next call (a market list of the mint) finds nothing.
 *
 * Before the app is told the mint exists, name those inputs and sign again.
 */
import type { Chain } from './vault'
import { inputOutpointsFromAtomicBeef } from './txOutpoints'
import { extractTxid } from './txExplorer'
import { parseOutpoint } from './legacyScan'

const PROBE_MS = 1_500

function wocSpentUrl(chain: Chain, txid: string, vout: number): string {
  const host =
    chain === 'main'
      ? 'https://api.whatsonchain.com/v1/bsv/main'
      : 'https://api.whatsonchain.com/v1/bsv/test'
  return `${host}/tx/${txid}/${vout}/spent`
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

export async function confirmedForeignSpenderTxid(
  outpoint: string,
  selfTxid: string,
  chain: Chain,
): Promise<string | null> {
  const parsed = parseOutpoint(outpoint)
  if (!parsed) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_MS)
  try {
    const res = await fetch(wocSpentUrl(chain, parsed.txid, parsed.vout), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    return parseConfirmedForeignSpender(await res.json(), selfTxid)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
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

export async function foreignConfirmedInputSpends(
  result: unknown,
  chain: Chain,
): Promise<Array<{ outpoint: string; spender: string }>> {
  const txid = extractTxid(result)?.toLowerCase()
  const atomic = atomicFromCreateResult(result)
  if (!txid || !atomic?.length) return []
  const inputs = inputOutpointsFromAtomicBeef(atomic, txid)
  const rows = await Promise.all(
    inputs.map(async (outpoint) => ({
      outpoint,
      spender: await confirmedForeignSpenderTxid(outpoint, txid, chain),
    })),
  )
  return rows.filter(
    (row): row is { outpoint: string; spender: string } => row.spender != null,
  )
}

/**
 * Hide coins a confirmed foreign tx already spent, and retire this signed tx
 * so its outputs are not listed as held. Returns true when a resign is required.
 */
export async function retireCreateActionSpentElsewhere(
  result: unknown,
  chain: Chain,
): Promise<boolean> {
  const txid = extractTxid(result)?.toLowerCase()
  if (!txid) return false
  const spends = await foreignConfirmedInputSpends(result, chain)
  if (spends.length === 0) return false
  const bySpender = new Map<string, string[]>()
  for (const row of spends) {
    const list = bySpender.get(row.spender) ?? []
    list.push(row.outpoint)
    bySpender.set(row.spender, list)
  }
  const { hideSpentOutpoints, failUnsentLocalTx } = await import(
    './staleOutputRelease'
  )
  for (const [spender, outpoints] of bySpender) {
    await hideSpentOutpoints(outpoints, spender)
  }
  await failUnsentLocalTx(txid, { force: true })
  console.warn(
    `[brc100] createAction inputs spent elsewhere count=${spends.length} txid=${txid.slice(0, 12)}`,
  )
  return true
}
