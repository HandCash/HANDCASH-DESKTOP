import { Hash, OP, PublicKey, Script, Utils } from '@bsv/sdk'

// Standard Bitcom MAP tape. The issuer fields are optional HandCash metadata,
// not a new token protocol. Sigma signs these bytes together with the asset script.
const MAP = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
/** `issuer` as a 6-byte push; digits only, so case never matters. */
const ISSUER_PUSH_HEX = '06697373756572'
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

/** `MAP SET issuer <identity key>` (BRC-247): the key the Sigma BRC-77 signature must recover. */
export function appendIssuerMetadata(scriptHex: string, issuer: string): string {
  const base = Script.fromHex(scriptHex)
  const tail = new Script()
  if (base.chunks.some((chunk) => chunk.op === OP.OP_RETURN))
    tail.writeBin(Utils.toArray('|'))
  else tail.writeOpCode(OP.OP_RETURN)
  for (const field of [MAP, 'SET', 'issuer', issuer]) tail.writeBin(Utils.toArray(field, 'utf8'))
  return Script.fromBinary([...base.toBinary(), ...tail.toBinary()]).toHex()
}

function sha256Hex(scriptHex: string): string {
  return Utils.toHex(Hash.sha256(Utils.toArray(scriptHex.trim().toLowerCase(), 'hex')))
}

/**
 * The unsigned BRC-247 stamp output for a BRC-162 deploy at output 0:
 * `OP_FALSE OP_RETURN MAP SET issuer <key> deploy <sha256(output 0)>`.
 * SIGMA is appended to it; the deploy lock itself stays plain custody.
 */
export function brc162StampScript(issuer: string, deployLockingScriptHex: string): string {
  const key = normalizeIssuerIdentityKey(issuer)
  if (!key) throw new Error('Invalid issuer identity key.')
  const script = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN)
  for (const field of [MAP, 'SET', 'issuer', key, 'deploy', sha256Hex(deployLockingScriptHex)])
    script.writeBin(Utils.toArray(field, 'utf8'))
  return script.toHex()
}

export type Brc162Stamp = { issuer: string; deploy: string }

/** The issuer tape of a BRC-162 stamp output, signed or not; null for any other script. */
export function brc162StampFromScript(scriptHex?: string): Brc162Stamp | null {
  if (!scriptHex || scriptHex.length > 20_000 || !scriptHex.includes(ISSUER_PUSH_HEX)) return null
  try {
    const chunks = expandedProtocolScript(scriptHex).chunks
    if (chunks[0]?.op !== OP.OP_FALSE || chunks[0].data?.length || chunks[1]?.op !== OP.OP_RETURN) return null
    const text = (i: number) => (chunks[i]?.data ? Utils.toUTF8(chunks[i].data!) : '')
    if (text(2) !== MAP || text(3) !== 'SET') return null
    const fields = new Map<string, string>()
    let i = 4
    for (; i + 1 < chunks.length && text(i) !== '|'; i += 2) {
      if (fields.has(text(i))) return null
      fields.set(text(i), text(i + 1))
    }
    if (i < chunks.length && text(i) !== '|') return null
    const issuer = normalizeIssuerIdentityKey(fields.get('issuer'))
    const deploy = fields.get('deploy') ?? ''
    if (!issuer || !/^[0-9a-f]{64}$/.test(deploy)) return null
    return { issuer, deploy }
  } catch {
    return null
  }
}

/** The stamp names exactly this output-0 locking script. */
export function brc162StampNames(stamp: Brc162Stamp, deployLockingScriptHex: string): boolean {
  return stamp.deploy === sha256Hex(deployLockingScriptHex)
}

/**
 * The issuer tape. `bapId` comes only from stamps written under earlier drafts
 * of BRC-247 by a BAP key; it is trusted once that identity's ID chain shows
 * the signer was its active key when the asset was signed.
 */
export function issuerMetadataFromScript(scriptHex?: string): {
  issuer?: string
  bapId?: string
} {
  if (!scriptHex || scriptHex.length > 2_000_000) return {}
  // Every card asks, and an item's script is its whole image: skip the parse
  // unless the tape's `issuer` push is in the bytes at all.
  if (!scriptHex.includes(ISSUER_PUSH_HEX)) return {}
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
