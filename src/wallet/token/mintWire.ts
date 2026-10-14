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
 *
 * BRC-162 as merged: no tag, a binary deploy is output 0, and the icon is the
 * image itself (`[mediaType, bytes]`). A deploy an app wrote in the pre-#273
 * draft-tagged layout is re-expressed in the current one, never issued as is
 * (BRC-251: no new deploys in that layout). The caller resolves the icon
 * reference to bytes, since a pointer cannot ride the current layout.
 */
import {
  decodeBsv21Binary,
  encodeBsv21Binary,
  tokenIdFromWire,
  type Bsv21BinaryPayload,
  type Bsv21IconImage,
} from './decode162'
import { isBsv21Mime, normalizeTokenId } from './types'
import { parseOrdEnvelope } from '../ordinalOwnership'

export type Bsv21MintWire =
  /** Already a current-layout BRC-162 lock at output 0 — issue as given. */
  | { kind: 'binary' }
  /** Re-expressed as current-layout BRC-162; issue this script instead. */
  | { kind: 'upgrade'; lockingScript: string; amount: bigint; sym?: string; iconDropped?: true }
  /** Not a JSON genesis we can re-express exactly. Issue as given. */
  | { kind: 'keep'; reason: string }
  /** Would issue a token no BRC-162 reader accepts. Do not sign. */
  | { kind: 'refuse'; reason: string }

/** Where a genesis says its icon lives, before the caller fetches the bytes. */
export type Bsv21DeployIconRef =
  | { kind: 'outpoint'; outpoint: string }
  | { kind: 'sameTx'; vout: number }

const P2PKH_TAIL_RE = /(76a914[0-9a-f]{40}88ac)$/
const P2PKH_ONLY_RE = /^76a914[0-9a-f]{40}88ac$/

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
  return payload
}

/** The icon a genesis names: a JSON `icon` outpoint or a draft-tagged pointer. */
export function bsv21DeployIconRef(lockingScriptHex: string): Bsv21DeployIconRef | null {
  const hex = lockingScriptHex.trim().toLowerCase()
  const binary = decodeBsv21Binary(hex)
  if (binary) {
    const icon = binary.layout === 'draft-tagged' ? binary.payload?.icon : undefined
    if (icon?.length === 36) {
      const outpoint = tokenIdFromWire(icon)
      return outpoint ? { kind: 'outpoint', outpoint } : null
    }
    if (icon?.length === 4) {
      return { kind: 'sameTx', vout: (icon[0]! | (icon[1]! << 8) | (icon[2]! << 16) | (icon[3]! << 24)) >>> 0 }
    }
    return null
  }
  const env = parseOrdEnvelope(hex)
  const json = env && isBsv21Mime(env.contentType) ? jsonOf(env.body) : null
  const outpoint = typeof json?.icon === 'string' ? normalizeTokenId(json.icon) : null
  return outpoint ? { kind: 'outpoint', outpoint } : null
}

function encodeUpgrade(args: {
  amount: bigint
  payload: Bsv21BinaryPayload
  rest: string
  hadIcon: boolean
  iconImage?: Bsv21IconImage | null
}): Bsv21MintWire {
  const payload: Bsv21BinaryPayload = {
    ...(args.payload.sym ? { sym: args.payload.sym } : {}),
    ...(args.payload.dec != null ? { dec: args.payload.dec } : {}),
    ...(args.iconImage ? { iconImage: args.iconImage } : {}),
  }
  let lockingScript: string
  try {
    lockingScript = encodeBsv21Binary({ amount: args.amount, payload, rest: args.rest })
      .toHex()
      .toLowerCase()
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
    decoded.layout !== 'brc162' ||
    decoded.role !== 'deploy' ||
    decoded.amount !== args.amount ||
    decoded.restScriptHex !== args.rest
  ) {
    return { kind: 'keep', reason: 'BRC-162 round-trip did not match the genesis' }
  }
  return {
    kind: 'upgrade',
    lockingScript,
    amount: args.amount,
    ...(payload.sym ? { sym: payload.sym } : {}),
    // An unusable icon must not cost the genesis its proof.
    ...(args.hadIcon && !args.iconImage ? { iconDropped: true as const } : {}),
  }
}

/**
 * Decide the wire for one `deploy+mint` locking script at output `vout`.
 * Pure: `iconImage` is the caller's resolution of {@link bsv21DeployIconRef}.
 */
export function planBsv21MintWire(
  lockingScriptHex: string,
  opts: { vout: number; iconImage?: Bsv21IconImage | null },
): Bsv21MintWire {
  const hex = lockingScriptHex.trim().toLowerCase()
  if (!hex) return { kind: 'keep', reason: 'no locking script' }
  const binary = decodeBsv21Binary(hex)
  if (binary) {
    if (binary.role !== 'deploy') return { kind: 'binary' }
    if (opts.vout !== 0) {
      return { kind: 'refuse', reason: `BRC-162 deploys must be output 0, not ${opts.vout}` }
    }
    if (binary.layout === 'brc162') return { kind: 'binary' }
    const rest = binary.restScriptHex
    if (!P2PKH_ONLY_RE.test(rest)) {
      return { kind: 'refuse', reason: 'draft-tagged genesis does not end in a plain P2PKH' }
    }
    const upgraded = encodeUpgrade({
      amount: binary.amount,
      payload: binary.payload ?? {},
      rest,
      hadIcon: !!binary.payload?.icon,
      iconImage: opts.iconImage,
    })
    return upgraded.kind === 'keep' ? { kind: 'refuse', reason: upgraded.reason } : upgraded
  }

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
  // A JSON deploy at a nonzero output is valid BRC-161; a binary one is not.
  if (opts.vout !== 0) return { kind: 'keep', reason: `genesis is output ${opts.vout}, not 0` }

  return encodeUpgrade({
    amount,
    payload: payloadOf(json),
    rest,
    hadIcon: typeof json.icon === 'string' && !!normalizeTokenId(json.icon),
    iconImage: opts.iconImage,
  })
}
