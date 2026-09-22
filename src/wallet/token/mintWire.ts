/**
 * Which wire a BSV-21 genesis is issued on.
 *
 * A `deploy+mint` written as a legacy JSON ord inscription cannot be proven:
 * BRC-176 `prove` reads BRC-162 locks, so a JSON genesis is born unverifiable,
 * paints as "Legacy", and offers Burn where Send belongs. Nothing downstream
 * can repair that — the wire is fixed the moment the transaction is signed.
 *
 * So the decision happens at issuance, before signing, and it is named. The
 * same holding re-expressed as a BRC-162 lock keeps its token id (the genesis
 * outpoint), its supply, and its metadata, and is provable from the moment it
 * exists. When the JSON cannot be re-expressed exactly we keep it rather than
 * guess — an inexact genesis would misstate supply forever.
 */
import {
  decodeBsv21Binary,
  encodeBsv21Binary,
  tokenIdToWire,
  type Bsv21BinaryPayload,
} from './decode162'
import { isBsv21Mime, normalizeTokenId } from './types'
import { parseOrdEnvelope } from '../ordinalOwnership'

export type Bsv21MintWire =
  /** Already a BRC-162 lock — issue as given. */
  | { kind: 'binary' }
  /** Re-expressed as BRC-162; issue this script instead. */
  | { kind: 'upgrade'; lockingScript: string; amount: bigint; sym?: string }
  /** Not a JSON genesis we can re-express exactly. Issue as given. */
  | { kind: 'keep'; reason: string }

const P2PKH_TAIL_RE = /(76a914[0-9a-f]{40}88ac)$/

function jsonOf(body: Uint8Array | undefined): Record<string, unknown> | null {
  if (!body?.length) return null
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function decOf(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 18) {
    return undefined
  }
  return n
}

function payloadOf(json: Record<string, unknown>): Bsv21BinaryPayload {
  const payload: Bsv21BinaryPayload = {}
  const sym = typeof json.sym === 'string' ? json.sym.trim().slice(0, 32) : ''
  if (sym) payload.sym = sym
  const dec = decOf(json.dec)
  if (dec != null) payload.dec = dec
  const icon =
    typeof json.icon === 'string' ? normalizeTokenId(json.icon) : null
  if (icon) {
    try {
      payload.icon = tokenIdToWire(icon)
    } catch {
      // An unusable icon reference must not cost the genesis its proof.
    }
  }
  return payload
}

/** Decide the wire for one `deploy+mint` locking script. Pure. */
export function planBsv21MintWire(lockingScriptHex: string): Bsv21MintWire {
  const hex = lockingScriptHex.trim().toLowerCase()
  if (!hex) return { kind: 'keep', reason: 'no locking script' }
  if (decodeBsv21Binary(hex)) return { kind: 'binary' }

  const env = parseOrdEnvelope(hex)
  if (!env) return { kind: 'keep', reason: 'not an ord inscription' }
  if (!isBsv21Mime(env.contentType)) {
    return { kind: 'keep', reason: `mime ${env.contentType ?? 'unknown'}` }
  }
  const json = jsonOf(env.body)
  if (!json) return { kind: 'keep', reason: 'inscription body is not JSON' }
  if (json.p !== 'bsv-20' || json.op !== 'deploy+mint') {
    return { kind: 'keep', reason: `op ${String(json.op ?? 'none')}` }
  }

  const amtRaw = typeof json.amt === 'string' ? json.amt.trim() : ''
  if (!/^\d+$/.test(amtRaw)) return { kind: 'keep', reason: 'no integer amt' }
  const amount = BigInt(amtRaw)
  if (amount <= 0n) return { kind: 'keep', reason: 'amt is not a holding' }

  const rest = P2PKH_TAIL_RE.exec(hex)?.[1]
  if (!rest) return { kind: 'keep', reason: 'genesis does not end in P2PKH' }

  const payload = payloadOf(json)
  let lockingScript: string
  try {
    lockingScript = encodeBsv21Binary({ amount, payload, rest }).toHex().toLowerCase()
  } catch (err) {
    return {
      kind: 'keep',
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  // Issue nothing we cannot read back: supply and role must survive the hop.
  const decoded = decodeBsv21Binary(lockingScript)
  if (
    !decoded ||
    decoded.role !== 'deploy' ||
    decoded.amount !== amount ||
    decoded.restScriptHex !== rest
  ) {
    return { kind: 'keep', reason: 'BRC-162 round-trip did not match the JSON' }
  }

  return {
    kind: 'upgrade',
    lockingScript,
    amount,
    ...(payload.sym ? { sym: payload.sym } : {}),
  }
}
