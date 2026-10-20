/**
 * Issuer stamps on items (BRC-247): a Sigma signature on the new output, bound
 * to its funding input. `customInstructions.issuer` and tag `issuer:<pubkey>`
 * are remittance mirrors only.
 */
import { Hash, OP, PrivateKey, PublicKey, Script, Transaction, Utils } from '@bsv/sdk'
import { Algorithm, Sigma as SigmaParser } from 'sigma-protocol'
import Sigma from '@1sat/templates/sigma'
import { expandedProtocolScript } from './issuerMetadata'

const PUBKEY_RE = /^(02|03)[0-9a-f]{64}$/i

export function normalizeIssuerPubKey(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null
  const hex = raw.trim().toLowerCase().replace(/^0x/, '')
  return PUBKEY_RE.test(hex) ? hex : null
}

export function shortIssuerLabel(issuer: string): string {
  const id = normalizeIssuerPubKey(issuer) ?? issuer.trim().toLowerCase()
  if (id.length < 12) return id
  return `${id.slice(0, 8)}…${id.slice(-6)}`
}

/** Issuer pubkey from CI and/or `issuer:<pubkey>` tag. */
export function issuerFromRemittance(args: {
  customInstructions?: string | null
  tags?: string[]
}): string | null {
  if (args.customInstructions) {
    try {
      const o = JSON.parse(args.customInstructions) as { issuer?: unknown }
      const fromCi = normalizeIssuerPubKey(
        typeof o.issuer === 'string' ? o.issuer : null,
      )
      if (fromCi) return fromCi
    } catch {
      // ignore
    }
  }
  for (const tag of args.tags ?? []) {
    if (!tag.startsWith('issuer:')) continue
    const pk = normalizeIssuerPubKey(tag.slice('issuer:'.length))
    if (pk) return pk
  }
  return null
}

/** Actual output bytes + funding vin + signer key, not an address-only hint.
 * This proves authorship, not chain inclusion or BRC-150 ancestry. */
function sigmaInputHash(txid: string, vout: number): number[] {
  return Hash.sha256([...Utils.toArray(txid, 'hex'), vout & 255, (vout >>> 8) & 255, (vout >>> 16) & 255, (vout >>> 24) & 255])
}

export type SigmaSigner = { address: string; /** BRC-77 only: the key the signature names. */ key?: string }

/** The output's Sigma signer, verified against its funding input; null when unsigned or invalid. */
export function verifiedSigmaSigner(tx: Transaction, outputIndex: number): SigmaSigner | null {
  try {
    if (!Number.isSafeInteger(outputIndex) || !tx.outputs[outputIndex]) return null
    const script = expandedProtocolScript(tx.outputs[outputIndex]!.lockingScript.toHex())
    const parsedTx = new Transaction()
    parsedTx.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0 })
    parsedTx.addOutput({ satoshis: 1, lockingScript: script })
    const sig = new SigmaParser(parsedTx).sig
    if (!sig?.address) return null
    // BRC-247: a stamp names a concrete input; signers resolve -1 before writing.
    const vin = sig.vin
    if (!Number.isSafeInteger(vin) || vin < 0 || !tx.inputs[vin]) return null
    const input = tx.inputs[vin]!
    const txid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
    if (!txid || !/^[0-9a-f]{64}$/i.test(txid)) return null
    const bytes = Utils.toArray(sig.signature, 'base64')
    let key: string | undefined
    if (sig.algorithm === Algorithm.BRC77) {
      // BRC-77 carries the actual signing key; its address field is not proof.
      key = Utils.toHex(bytes.slice(4, 37)).toLowerCase()
      if (PublicKey.fromString(key).toAddress() !== sig.address) return null
    } else if (sig.algorithm !== Algorithm.BSM) return null
    const index = script.chunks.findIndex(chunk => chunk.data && Utils.toUTF8(chunk.data) === 'SIGMA')
    if (index < 1) return null
    const separator = script.chunks[index - 1]!
    if (separator.op !== OP.OP_RETURN && (!separator.data || Utils.toUTF8(separator.data) !== '|')) return null
    const prefix = new Script(script.chunks.slice(0, index - 1)).toBinary()
    const valid = new Sigma({ algorithm: sig.algorithm, address: sig.address, signature: bytes, vin: sig.vin })
      .verifyWithHashes(sigmaInputHash(txid, input.sourceOutputIndex), Hash.sha256(prefix))
    return valid ? { address: sig.address, ...(key ? { key } : {}) } : null
  } catch { return null }
}

const addressByKey = new Map<string, string>()

/** Listing asks per tip on every refresh; point decompression is not free on a phone. */
function addressOfKey(key: string): string {
  const known = addressByKey.get(key)
  if (known) return known
  const address = PublicKey.fromString(key).toAddress()
  if (addressByKey.size >= 512) addressByKey.clear()
  addressByKey.set(key, address)
  return address
}

export function sigmaSignerIs(signer: SigmaSigner | null, issuer: string): boolean {
  if (!signer) return false
  const key = normalizeIssuerPubKey(issuer)
  if (!key) return false
  try {
    return signer.address === addressOfKey(key) && (signer.key === undefined || signer.key === key)
  } catch {
    return false
  }
}

export function verifySigmaIssuer(tx: Transaction, outputIndex: number, issuer: string): boolean {
  return sigmaSignerIs(verifiedSigmaSigner(tx, outputIndex), issuer)
}

/**
 * Append Sigma (BRC-77) to a new output's locking script, bound to funding
 * vin 0. Caller must ensure createAction spends the funding outpoint as input 0.
 */
export function sigmaSignLockingScript(args: {
  lockingScriptHex: string
  fundTxid: string
  fundVout: number
  identityKeyHex: string
}): string {
  const root = PrivateKey.fromHex(args.identityKeyHex)
  const base = Script.fromHex(args.lockingScriptHex.trim().toLowerCase())
  if (!/^[0-9a-f]{64}$/i.test(args.fundTxid) || !Number.isSafeInteger(args.fundVout) || args.fundVout < 0 || args.fundVout > 0xffffffff) throw new Error('Invalid Sigma funding outpoint.')
  const expanded = expandedProtocolScript(base.toHex())
  if (expanded.chunks.some(chunk => chunk.data && Utils.toUTF8(chunk.data) === 'SIGMA')) throw new Error('New issuance already contains a Sigma signature.')
  // @1sat/templates 0.0.2 exposes sign/verifyWithHashes. Use raw prefix
  // bytes exactly as the SDK's current computeDataHash / go-sigma specifies.
  const sigma = Sigma.sign(sigmaInputHash(args.fundTxid.toLowerCase(), args.fundVout), Hash.sha256(base.toBinary()), root, { algorithm: Algorithm.BRC77, vin: 0 })
  const tail = new Script()
  if (base.chunks.some(chunk => chunk.op === OP.OP_RETURN)) tail.writeBin(Utils.toArray('|'))
  else tail.writeOpCode(OP.OP_RETURN)
  for (const value of ['SIGMA', sigma.data.algorithm, sigma.data.address]) tail.writeBin(Utils.toArray(value, 'utf8'))
  tail.writeBin(sigma.data.signature)
  tail.writeBin(Utils.toArray('0'))
  return Script.fromBinary([...base.toBinary(), ...tail.toBinary()]).toHex()
}
