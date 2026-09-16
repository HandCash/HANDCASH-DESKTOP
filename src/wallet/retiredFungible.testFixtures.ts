/** Fixtures used only to verify that removed fungible outputs stay quarantined. */
import { ordEnvelopeHex } from './ordScriptPush'
import { p2pkhScriptHex } from './ordinalOwnership'

const RETIRED_MIME = 'application/1sat-ft+json'
const encoder = new TextEncoder()

function lock(
  address: string,
  json: Record<string, string | number>,
): { lockingScript: string; json: Record<string, string | number> } {
  return {
    lockingScript: (
      ordEnvelopeHex(RETIRED_MIME, encoder.encode(JSON.stringify(json))) +
      p2pkhScriptHex(address)
    ).toLowerCase(),
    json,
  }
}

export function buildRetiredFungibleOrigin(args: {
  address: string
  sym: string
  name?: string
  amt?: number
  maxSupply?: number
  supply?: 'locked' | 'open'
}): ReturnType<typeof lock> {
  const json: Record<string, string | number> = {
    p: '1sat-ft',
    op: 'deploy+mint',
    sym: args.sym,
  }
  if (args.name) json.name = args.name
  if (args.amt != null) json.amt = args.amt
  if (args.maxSupply != null) json.maxSupply = args.maxSupply
  if (args.supply) json.supply = args.supply
  return lock(args.address, json)
}

export function buildRetiredFungibleTransfer(args: {
  address: string
  amt: number
}): ReturnType<typeof lock> {
  if (!Number.isSafeInteger(args.amt) || args.amt <= 0) {
    throw new Error('Transfer amount must be a positive integer')
  }
  return lock(args.address, { amt: String(args.amt) })
}
