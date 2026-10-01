import { OP, Script, Utils } from '@bsv/sdk'
import {
  normalizePublicIdentityKey,
  verifyPublicIdentityProfile,
  type PublicIdentityProfile,
} from './publicIdentityProfile'

// Standard Bitcom MAP tape. The issuer/profile fields are optional HandCash metadata,
// not a new token protocol. Sigma signs these bytes together with the asset script.
const MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
/** SDK 2.x folds a data-bearing OP_RETURN; protocol parsers need its push tape. */
export function expandedProtocolScript(scriptHex: string): Script {
  const script = Script.fromHex(scriptHex)
  return new Script(
    script.chunks.flatMap((chunk) =>
      chunk.op === OP.OP_RETURN && chunk.data?.length
        ? [{ op: OP.OP_RETURN }, ...Script.fromBinary(chunk.data).chunks]
        : [chunk],
    ),
  )
}
export function appendIssuerMetadata(
  scriptHex: string,
  issuer: string,
  profile?: PublicIdentityProfile,
): string {
  const base = Script.fromHex(scriptHex)
  const tail = new Script()
  if (base.chunks.some((chunk) => chunk.op === OP.OP_RETURN))
    tail.writeBin(Utils.toArray('|'))
  else tail.writeOpCode(OP.OP_RETURN)
  for (const field of [
    MAP,
    'SET',
    'issuer',
    issuer,
    ...(profile ? ['issuerProfile', JSON.stringify(profile)] : []),
  ])
    tail.writeBin(Utils.toArray(field, 'utf8'))
  return Script.fromBinary([...base.toBinary(), ...tail.toBinary()]).toHex()
}

export function issuerMetadataFromScript(scriptHex?: string): {
  issuer?: string
  issuerProfile?: PublicIdentityProfile
} {
  if (!scriptHex || scriptHex.length > 2_000_000) return {}
  try {
    const chunks = expandedProtocolScript(scriptHex).chunks
    const text = (i: number) =>
      chunks[i]?.data && chunks[i].data!.length <= 4096
        ? Utils.toUTF8(chunks[i].data!)
        : ''
    // Only recognize the unambiguous tape shape this wallet writes. Ignore
    // arbitrary nested inscription content and reject conflicting issuer tapes.
    let result:
      | { issuer: string; issuerProfile?: PublicIdentityProfile }
      | undefined
    for (let i = 1; i < chunks.length - 3; i++) {
      if (text(i) !== MAP || text(i + 1) !== 'SET' || text(i + 2) !== 'issuer')
        continue
      if (chunks[i - 1]?.op !== OP.OP_RETURN && text(i - 1) !== '|') continue
      const issuer = normalizePublicIdentityKey(text(i + 3))
      if (!issuer || result) return {}
      const raw =
        text(i + 4) === 'issuerProfile' && text(i + 5).length < 4096
          ? text(i + 5)
          : ''
      const profile = raw
        ? verifyPublicIdentityProfile(JSON.parse(raw), issuer)
        : null
      result = { issuer, ...(profile ? { issuerProfile: profile } : {}) }
    }
    return result ?? {}
  } catch {
    return {}
  }
}
