/**
 * 1Sat inscription chained with a Sigma output script, bound to a concrete VIN.
 *
 * Layout (1Sat signing + Sigma):
 *
 *   <P2PKH>
 *   OP_FALSE OP_IF "ord" OP_1 <mime> OP_0 <body> OP_ENDIF
 *   OP_RETURN
 *     <signed metadata json>
 *     |
 *     SIGMA
 *     BSM
 *     <signing address>
 *     <signature>
 *     <vin>
 *
 * VIN is a non-negative input index. `-1` is refused — it does not bind a
 * specific outpoint, so the signature can be replayed onto another spend.
 */

import { PrivateKey, Script, Transaction } from '@bsv/sdk'
import { Algorithm, Sigma } from 'sigma-protocol'
import { ordEnvelopeHex } from '../ordScriptPush'
import { parseOrdEnvelope } from '../ordinalOwnership'
import { p2pkhScriptHex } from '../ordinalOwnership'
import { SIGMA_IDENTITY_MIME, SIGMA_MARKER_HEX } from './constants'
import { parseIdentityDocument, type SigmaIdentityDocument } from './payload'

export type ParsedSigmaTail = {
  address: string
  algorithm: 'BSM' | 'BRC77'
  vin: number
  /** True only when the signature names a specific input. */
  vinBound: boolean
}

function assertVin(vin: number): number {
  if (!Number.isInteger(vin) || vin < 0 || vin > 0xffff) {
    throw new Error('Sigma identity signatures must bind a specific input (VIN ≥ 0).')
  }
  return vin
}

function scriptHasOpReturn(hex: string): boolean {
  const bytes = hex.trim().toLowerCase()
  // OP_RETURN is 0x6a. Avoid matching it inside push data by scanning opcodes
  // only well enough for "already has a tail" — Sigma itself adds one.
  return bytes.includes('6a')
}

function appendOpReturnJson(lockingScriptHex: string, json: string): string {
  const script = Script.fromHex(lockingScriptHex.trim().toLowerCase())
  script.writeOpCode(0x6a)
  script.writeBin(Array.from(new TextEncoder().encode(json)))
  return script.toHex().toLowerCase()
}

/**
 * Append a BSM Sigma tail bound to `vin` (default 0).
 * Existing OP_RETURN data is signed in place. If there is none and `metadataJson`
 * is set, that JSON is pushed first so the library inserts the `|` separator.
 */
export function appendSigmaAttestation(args: {
  lockingScriptHex: string
  fundTxid: string
  fundVout: number
  signer: PrivateKey
  vin?: number
  metadataJson?: string
}): string {
  const vin = assertVin(args.vin ?? 0)
  const txid = args.fundTxid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(args.fundVout) || args.fundVout < 0) {
    throw new Error('Sigma identity needs the funding outpoint before it can sign.')
  }
  let locking = args.lockingScriptHex.trim().toLowerCase()
  if (!locking) throw new Error('Nothing to sign.')
  if (locking.includes(SIGMA_MARKER_HEX)) {
    throw new Error('Output already has a Sigma signature.')
  }
  if (args.metadataJson && !scriptHasOpReturn(locking)) {
    locking = appendOpReturnJson(locking, args.metadataJson)
  }
  const tx = new Transaction()
  tx.addInput({
    sourceTXID: txid,
    sourceOutputIndex: args.fundVout,
  })
  tx.addOutput({
    satoshis: 1,
    lockingScript: Script.fromHex(locking),
  })
  const sigma = new Sigma(tx, 0, 0, vin)
  const { signedTx } = sigma.sign(args.signer, Algorithm.BSM)
  const hex = signedTx.outputs[0]?.lockingScript?.toHex()
  if (!hex) throw new Error('Sigma sign produced no locking script')
  return hex.toLowerCase()
}

/** Persona document: P2PKH ‖ ord envelope ‖ signed meta ‖ Sigma bound to VIN. */
export function buildIdentityInscriptionScript(args: {
  address: string
  body: Uint8Array
  metadataJson: string
  fundTxid: string
  fundVout: number
  signer: PrivateKey
  vin?: number
}): string {
  const envelope = ordEnvelopeHex(SIGMA_IDENTITY_MIME, args.body)
  const locking = (p2pkhScriptHex(args.address) + envelope).toLowerCase()
  return appendSigmaAttestation({
    lockingScriptHex: locking,
    fundTxid: args.fundTxid,
    fundVout: args.fundVout,
    signer: args.signer,
    vin: args.vin,
    metadataJson: args.metadataJson,
  })
}

export function parseSigmaTail(lockingScriptHex: string): ParsedSigmaTail | null {
  const hex = lockingScriptHex.trim().toLowerCase()
  if (!hex.includes(SIGMA_MARKER_HEX)) return null
  try {
    const tx = new Transaction()
    tx.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
    })
    tx.addOutput({
      satoshis: 1,
      lockingScript: Script.fromHex(hex),
    })
    const sig = new Sigma(tx, 0, 0, 0).sig
    if (!sig?.address) return null
    const vin = sig.vin
    return {
      address: sig.address,
      algorithm: sig.algorithm === Algorithm.BRC77 ? 'BRC77' : 'BSM',
      vin,
      vinBound: Number.isInteger(vin) && vin >= 0,
    }
  } catch {
    return null
  }
}

export function identityDocumentFromLockingScript(
  lockingScriptHex: string,
): SigmaIdentityDocument | null {
  const env = parseOrdEnvelope(lockingScriptHex)
  if (!env?.body.length) return null
  const mime = env.contentType?.split(';')[0]?.trim().toLowerCase()
  if (mime && mime !== SIGMA_IDENTITY_MIME) return null
  return parseIdentityDocument(env.body)
}

/**
 * Full VIN check. Rejects unbound (`vin < 0`) signatures even if the bytes verify.
 * `tx` must include the real input at the bound index.
 */
export function verifySigmaVinBinding(
  tx: Transaction,
  outputIndex: number,
  expectedVin = 0,
): boolean {
  if (!Number.isInteger(expectedVin) || expectedVin < 0) return false
  try {
    const sigma = new Sigma(tx, outputIndex, 0, expectedVin)
    const sig = sigma.sig
    if (!sig || sig.vin !== expectedVin || sig.vin < 0) return false
    return sigma.verify()
  } catch {
    return false
  }
}
