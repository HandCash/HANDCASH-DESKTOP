/**
 * Build 1Sat fungible (BRC-175) genesis locking scripts — ord envelope ‖ P2PKH.
 * Used by Mint Studio / tests; wallet hold/send does not mint.
 */
import {
  buildOnesatFtOriginInscriptionJson,
  ONESAT_FT_PROTOCOL,
  type ColourSupply,
} from './colourCoins'
import { p2pkhScriptHex } from './ordinalOwnership'

const OP_FALSE = '00'
const OP_IF = '63'
const OP_ENDIF = '68'
const OP_1 = '51'
const OP_0 = '00'
const MIME = 'application/1sat-ft+json'

const encoder = new TextEncoder()

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function pushData(data: Uint8Array): string {
  const n = data.length
  if (n === 0) return OP_0
  const body = bytesToHex(data)
  if (n <= 75) return n.toString(16).padStart(2, '0') + body
  if (n <= 255) return `4c${n.toString(16).padStart(2, '0')}${body}`
  if (n <= 65535) {
    const lo = (n & 0xff).toString(16).padStart(2, '0')
    const hi = ((n >> 8) & 0xff).toString(16).padStart(2, '0')
    return `4d${lo}${hi}${body}`
  }
  throw new Error('Inscription body too large')
}

function pushText(text: string): string {
  return pushData(encoder.encode(text))
}

function ordEnvelopeHex(contentType: string, body: Uint8Array): string {
  return (
    OP_FALSE +
    OP_IF +
    pushText('ord') +
    OP_1 +
    pushText(contentType) +
    OP_0 +
    pushData(body) +
    OP_ENDIF
  ).toLowerCase()
}

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

export { ONESAT_FT_PROTOCOL, MIME as ONESAT_FT_MIME }
