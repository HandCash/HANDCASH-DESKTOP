/**
 * Build 1Sat fungible (BRC-175) genesis locking scripts — ord envelope ‖ P2PKH.
 * Used by Mint Studio / tests; wallet hold/send does not mint.
 */
import {
  buildOnesatFtOriginInscriptionJson,
  ONESAT_FT_PROTOCOL,
  type ColourSupply,
} from './colourCoins'
import { ordEnvelopeHex } from './ordScriptPush'
import { p2pkhScriptHex } from './ordinalOwnership'

const MIME = 'application/1sat-ft+json'

const encoder = new TextEncoder()

export function buildOnesatFtMintLockingScript(args: {
  address: string
  sym: string
  name?: string
  /** Face value of the genesis tip. Defaults to maxSupply when locking. */
  amt?: number
  /** Optional locked total units. Omit for uncapped origin. */
  maxSupply?: number
  supply?: ColourSupply
}): { lockingScript: string; json: Record<string, string | number> } {
  const json = buildOnesatFtOriginInscriptionJson({
    sym: args.sym,
    name: args.name,
    amt: args.amt,
    ...(args.supply === 'locked' || args.maxSupply != null
      ? {
          supply: args.supply ?? 'locked',
          maxSupply: args.maxSupply,
        }
      : args.supply === 'open'
        ? { supply: 'open' as const }
        : {}),
  })
  const body = encoder.encode(JSON.stringify(json))
  return {
    lockingScript: (
      ordEnvelopeHex(MIME, body) + p2pkhScriptHex(args.address)
    ).toLowerCase(),
    json,
  }
}


/** Leftover tip: amt on chain. Origin is the BRC-150 / spend-chain walk, like 1sat. */
export function buildOnesatFtTransferLockingScript(args: {
  address: string
  amt: number
}): { lockingScript: string; json: Record<string, string> } {
  if (!Number.isSafeInteger(args.amt) || args.amt <= 0) {
    throw new Error('Transfer amt must be a positive integer')
  }
  const json: Record<string, string> = { amt: String(args.amt) }
  const body = encoder.encode(JSON.stringify(json))
  return {
    lockingScript: (
      ordEnvelopeHex(MIME, body) + p2pkhScriptHex(args.address)
    ).toLowerCase(),
    json,
  }
}

export { ONESAT_FT_PROTOCOL, MIME as ONESAT_FT_MIME }
