import { parseOrdEnvelope } from '../ordinalOwnership'
import { decodeBsv21Binary, iconOutpointFromPayload } from './decode162'
import { parseBsv21Json } from './types'

export type DeployDisplay = {
  sym?: string
  icon?: string
  issuer?: string
  dec?: number
  encoding: 'binary' | 'json'
}

/**
 * Display fields from the deploy output — the record later outputs inherit
 * (BRC-162 §roles). BRC-162 binary CBOR payload first, BRC-161 JSON body
 * second; a value tip's own payload is OP_0 and carries nothing.
 */
export function deployDisplayFromScript(
  scriptHex: string | undefined,
  tokenId: string,
): DeployDisplay | null {
  if (!scriptHex) return null
  const binary = decodeBsv21Binary(scriptHex)
  if (binary?.role === 'deploy') {
    const icon = iconOutpointFromPayload(binary.payload?.icon, tokenId)
    return {
      encoding: 'binary',
      ...(binary.payload?.sym ? { sym: binary.payload.sym } : {}),
      ...(binary.payload?.dec != null ? { dec: binary.payload.dec } : {}),
      ...(icon ? { icon } : {}),
    }
  }
  const envelope = parseOrdEnvelope(scriptHex)
  if (!envelope?.body?.length) return null
  try {
    const json = parseBsv21Json(JSON.parse(new TextDecoder().decode(envelope.body)))
    if (!json) return null
    return {
      encoding: 'json',
      ...(json.sym ? { sym: json.sym } : {}),
      ...(json.icon ? { icon: json.icon } : {}),
      ...(json.issuer ? { issuer: json.issuer } : {}),
      ...(json.dec != null ? { dec: json.dec } : {}),
    }
  } catch {
    return null
  }
}
