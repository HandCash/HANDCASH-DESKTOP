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
 *
 * Note: @bsv/sdk Script.fromHex/toBinary folds everything after OP_RETURN into
 * the OP_RETURN payload. We therefore sign the inscription-only prefix (the
 * same bytes getDataHash uses for OP_RETURN-embedded SIGMA) and append the
 * OP_RETURN tail as raw hex so parseOrdEnvelope / verify stay consistent.
 */

import { BSM, BigNumber, PrivateKey, Script, Signature, Transaction } from '@bsv/sdk'
import { Algorithm, Sigma } from 'sigma-protocol'
import { ordEnvelopeHex, pushData, pushText } from '../ordScriptPush'
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

function compactHexToBytes(compactHex: string): number[] {
  const out: number[] = []
  for (let i = 0; i < compactHex.length; i += 2) {
    out.push(Number.parseInt(compactHex.slice(i, i + 2), 16))
  }
  return out
}

/**
 * Append a BSM Sigma tail bound to `vin` (default 0).
 * Signs the locking script prefix (before any OP_RETURN). Optional
 * `metadataJson` is placed in the OP_RETURN ahead of `|` / SIGMA.
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
  let prefix = args.lockingScriptHex.trim().toLowerCase()
  if (!prefix) throw new Error('Nothing to sign.')
  if (prefix.includes(SIGMA_MARKER_HEX)) {
    throw new Error('Output already has a Sigma signature.')
  }
  // Strip a trailing OP_RETURN payload if the caller already attached one —
  // we re-append metadata ourselves so the signed prefix stays inscription-only.
  const opReturnAt = (() => {
    try {
      const script = Script.fromHex(prefix)
      const idx = script.chunks.findIndex((c) => c.op === 0x6a)
      if (idx < 0) return -1
      // Rebuild hex of chunks before OP_RETURN
      const head = new Script()
      for (let i = 0; i < idx; i++) {
        const c = script.chunks[i]!
        if (c.data) head.writeBin(Array.from(c.data))
        else if (c.op !== undefined) head.writeOpCode(c.op)
      }
      return head.toHex().toLowerCase()
    } catch {
      return -1
    }
  })()
  if (typeof opReturnAt === 'string' && opReturnAt.length > 0) {
    prefix = opReturnAt
  }

  const tx = new Transaction()
  tx.addInput({
    sourceTXID: txid,
    sourceOutputIndex: args.fundVout,
  })
  tx.addOutput({
    satoshis: 1,
    lockingScript: Script.fromHex(prefix),
  })
  const sigma = new Sigma(tx, 0, 0, vin)
  const message = sigma.getMessageHash()
  const signature = BSM.sign(message, args.signer, 'raw') as Signature
  const address = args.signer.toAddress()
  const recovery = signature.CalculateRecoveryFactor(
    args.signer.toPublicKey(),
    new BigNumber(BSM.magicHash(message)),
  )
  const compactHex = signature.toCompact(recovery, true, 'hex') as string
  const utf8 = new TextEncoder()
  const metaPush = args.metadataJson
    ? pushData(utf8.encode(args.metadataJson))
    : ''
  // OP_RETURN <meta?> | SIGMA BSM <address> <sig> <vin>
  return (
    prefix +
    '6a' +
    metaPush +
    '017c' +
    pushText('SIGMA') +
    pushText(Algorithm.BSM) +
    pushText(address) +
    pushData(Uint8Array.from(compactHexToBytes(compactHex))) +
    pushText(String(vin))
  ).toLowerCase()
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
