/**
 * Build BSV-21 transfer locking scripts (BRC-160 envelope ‖ P2PKH).
 *
 * Same shape mint-studio uses for deploy/mint/transfer — kept local so the
 * wallet can send fungibles without depending on that proprietary package.
 */
import { BSV21_MIME, BSV21_PROTOCOL, normalizeTokenId } from './bsv21'
import { ordEnvelopeHex } from './ordScriptPush'
import { p2pkhScriptHex } from './ordinalOwnership'

const encoder = new TextEncoder()

/** Envelope then spendable P2PKH — the BSV-21 transfer tip. */
export function inscribedBsv21OutputHex(args: {
  address: string
  body: Uint8Array
}): string {
  return (
    ordEnvelopeHex(BSV21_MIME, args.body) + p2pkhScriptHex(args.address)
  ).toLowerCase()
}

/**
 * Locking script + inscription JSON for a BSV-21 `transfer` tip.
 */
export function buildBsv21TransferLockingScript(args: {
  address: string
  tokenId: string
  amt: string
  sym?: string
  icon?: string
  dec?: number
}): { lockingScript: string; json: Record<string, string> } {
  const id = normalizeTokenId(args.tokenId)
  if (!id) throw new Error('Invalid token id')
  const amt = args.amt.replace(/\D/g, '')
  if (!amt || amt === '0') throw new Error('Transfer amount must be positive')
  const json: Record<string, string> = {
    p: BSV21_PROTOCOL,
    op: 'transfer',
    id,
    amt,
  }
  if (args.sym?.trim()) json.sym = args.sym.trim().slice(0, 32)
  if (args.icon?.trim()) {
    const icon = normalizeTokenId(args.icon) ?? args.icon.trim()
    json.icon = icon
  }
  if (args.dec != null && args.dec > 0) json.dec = String(args.dec)
  const body = encoder.encode(JSON.stringify(json))
  return {
    lockingScript: inscribedBsv21OutputHex({ address: args.address, body }),
    json,
  }
}

/** Canonical BSV-21 burn inscription. A burn output carries no token balance. */
export function buildBsv21BurnLockingScript(args: {
  address: string
  tokenId: string
  amt: string
}): { lockingScript: string; json: Record<string, string> } {
  const id = normalizeTokenId(args.tokenId)
  if (!id) throw new Error('Invalid token id')
  if (!/^\d+$/.test(args.amt.trim()) || BigInt(args.amt.trim()) <= 0n) {
    throw new Error('Burn amount must be positive')
  }
  const json = {
    p: BSV21_PROTOCOL,
    op: 'burn',
    id,
    amt: BigInt(args.amt.trim()).toString(),
  }
  return {
    lockingScript: inscribedBsv21OutputHex({
      address: args.address,
      body: encoder.encode(JSON.stringify(json)),
    }),
    json,
  }
}
