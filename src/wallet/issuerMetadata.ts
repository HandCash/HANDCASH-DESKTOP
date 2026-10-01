import { OP, PublicKey, Script, Utils } from '@bsv/sdk'

// Standard Bitcom MAP tape. The issuer fields are optional HandCash metadata,
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

/** Lowercase compressed public key on the curve, or null. */
export function normalizeIssuerIdentityKey(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(02|03)[0-9a-f]{64}$/i.test(value.trim())) return null
  try {
    return PublicKey.fromString(value.trim()).toString().toLowerCase()
  } catch {
    return null
  }
}

/** A BAP ID: base58 of a 20-byte hash, or null. */
export function normalizeBapId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (!/^[1-9A-HJ-NP-Za-km-z]{20,40}$/.test(id)) return null
  try {
    return Utils.fromBase58(id).length === 20 ? id : null
  } catch {
    return null
  }
}

/**
 * `MAP SET issuer <signing key> bapId <id>`. The BAP ID is a claim the Sigma
 * signer commits to; it is only trusted once that identity's ID chain shows
 * the signer was its active key when the asset was signed.
 */
export function appendIssuerMetadata(scriptHex: string, issuer: string, bapId?: string): string {
  const id = bapId === undefined ? null : normalizeBapId(bapId)
  if (bapId !== undefined && !id) throw new Error('Issuer BAP ID is invalid.')
  const base = Script.fromHex(scriptHex)
  const tail = new Script()
  if (base.chunks.some((chunk) => chunk.op === OP.OP_RETURN))
    tail.writeBin(Utils.toArray('|'))
  else tail.writeOpCode(OP.OP_RETURN)
  for (const field of [MAP, 'SET', 'issuer', issuer, ...(id ? ['bapId', id] : [])])
    tail.writeBin(Utils.toArray(field, 'utf8'))
  return Script.fromBinary([...base.toBinary(), ...tail.toBinary()]).toHex()
}

export function issuerMetadataFromScript(scriptHex?: string): {
  issuer?: string
  bapId?: string
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
    // Legacy `issuerProfile` JSON is self-asserted and is ignored.
    let result: { issuer: string; bapId?: string } | undefined
    for (let i = 1; i < chunks.length - 3; i++) {
      if (text(i) !== MAP || text(i + 1) !== 'SET' || text(i + 2) !== 'issuer')
        continue
      if (chunks[i - 1]?.op !== OP.OP_RETURN && text(i - 1) !== '|') continue
      const issuer = normalizeIssuerIdentityKey(text(i + 3))
      if (!issuer || result) return {}
      const bapId = text(i + 4) === 'bapId' ? normalizeBapId(text(i + 5)) : null
      result = { issuer, ...(bapId ? { bapId } : {}) }
    }
    return result ?? {}
  } catch {
    return {}
  }
}
