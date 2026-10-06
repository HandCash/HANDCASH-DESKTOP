import { Utils } from '@bsv/sdk'
import { parseOrdEnvelope } from './ordinalOwnership'
import { ordEnvelopeHex } from './ordScriptPush'
import { normalizeTokenId } from './token/types'

/**
 * MNEE vocabulary with no network or wallet dependencies, so Collect, the
 * misfiled-token heal and the import scan can recognise MNEE without loading
 * the cosigner client (`mnee.ts`).
 *
 * Every MNEE output is `ord envelope ‖ OWNER P2PKH CHECKSIGVERIFY ‖ <approver>
 * CHECKSIG`.
 */

export const MNEE_TOKEN_ID = 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0'
export const MNEE_TAG = 'mnee'
export const MNEE_COLLECTION_ID = 'mnee'
export const MNEE_SYMBOL = 'MNEE'
export const MNEE_DECIMALS = 5

const BSV20_MIME = 'application/bsv-20'
const COSIGN_LOCK = /76a914([0-9a-f]{40})88ad21([0-9a-f]{66})ac$/

export function isMneeTokenId(id: string | null | undefined): boolean {
  return !!id && normalizeTokenId(id) === MNEE_TOKEN_ID
}

/** An accepted MNEE row in basket `1sat`: Collect shows it, Tokens and heals leave it. */
export function isMneeItem(item: { tags?: readonly string[]; collectionId?: string }): boolean {
  return item.collectionId === MNEE_COLLECTION_ID || (item.tags?.includes(MNEE_TAG) ?? false)
}

/** Owner hash of a cosign lock (`… 88ad21 <approver> ac`), inscription or not. */
export function cosignedOwnerHash(scriptHex: string | null | undefined): string | null {
  return COSIGN_LOCK.exec(scriptHex?.trim().toLowerCase() ?? '')?.[1] ?? null
}

export type MneeTip = { ownerHash: string; approver: string; amt: bigint }

/** An MNEE output read from its own locking script; null for anything else. */
export function parseMneeTip(scriptHex: string | null | undefined): MneeTip | null {
  const hex = scriptHex?.trim().toLowerCase()
  if (!hex) return null
  const lock = COSIGN_LOCK.exec(hex)
  if (!lock) return null
  const envelope = parseOrdEnvelope(hex)
  if (envelope?.contentType?.split(';')[0]?.trim().toLowerCase() !== BSV20_MIME) return null
  let json: Record<string, unknown>
  try {
    json = JSON.parse(new TextDecoder().decode(envelope.body)) as Record<string, unknown>
  } catch {
    return null
  }
  if (json.p !== 'bsv-20' || json.op !== 'transfer') return null
  if (typeof json.id !== 'string' || !isMneeTokenId(json.id)) return null
  if (typeof json.amt !== 'string' || !/^\d+$/.test(json.amt)) return null
  const amt = BigInt(json.amt)
  if (amt <= 0n) return null
  return { ownerHash: lock[1]!, approver: lock[2]!, amt }
}

/** `ord envelope ‖ cosign lock` for `amt` base units owned by `address`. */
export function mneeOutputScriptHex(address: string, amt: bigint, approver: string): string {
  const { data } = Utils.fromBase58Check(address)
  const hash = Utils.toHex(data as number[])
  const body = new TextEncoder().encode(
    JSON.stringify({ p: 'bsv-20', op: 'transfer', id: MNEE_TOKEN_ID, amt: amt.toString() }),
  )
  return `${ordEnvelopeHex(BSV20_MIME, body)}76a914${hash}88ad21${approver}ac`.toLowerCase()
}

export function formatMnee(amt: bigint): string {
  const raw = amt.toString().padStart(MNEE_DECIMALS + 1, '0')
  const whole = BigInt(raw.slice(0, -MNEE_DECIMALS)).toLocaleString()
  const frac = raw.slice(-MNEE_DECIMALS).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}
