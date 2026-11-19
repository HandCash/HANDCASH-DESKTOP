import { Hash, PublicKey, Transaction, TransactionSignature, Utils, UnlockingScript } from '@bsv/sdk'
import { inputScriptValid, sighashPreimage, sourceOutputOf, sourceTxidOf } from '../txInputs'
import { BNT_HOLDER_SCOPE, BNT_ISSUER_SCOPE, bntIssuerUnlock, readBnt, sameRules } from './script'
import type { BntDeploy } from './validity'

/** BRC-253 §§4–6: bounded, holder-signed acceptor-funded proposal.
 * This is validation, NOT acceptance: callers must still verify linkage/policy,
 * reserve durably, fund, countersign and persist before replying.
 */
export type IptProposal = {
  requestId: string
  ef: number[]
  assetId: string
  inputs: string[]
  holders: string[]
  amount: bigint
}
export const IPT_PROPOSAL_MAX_BYTES = 1024 * 1024
export const IPT_PROPOSAL_MAX_INPUTS = 100
export const IPT_PROPOSAL_MAX_OUTPUTS = 100

/** The commitment is to the exact EF bytes, not JSON or a reconstructed txid. */
export function iptRequestId(ef: number[]): string {
  if (ef.length === 0 || ef.length > IPT_PROPOSAL_MAX_BYTES ||
      ef.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('Invalid IPT proposal bytes')
  }
  return Utils.toHex(Hash.sha256(ef))
}

/** Requires trusted deploy facts and exact source scripts from the accepted set.
 * EF parent values alone never establish that an input belongs to that set.
 * Authority/mint and sender-funded trades deliberately have separate validators.
 */
export function validateIptProposal(
  ef: number[],
  deploy: BntDeploy,
  accepted: ReadonlyMap<string, { satoshis: number; lockingScript: string }>,
): IptProposal {
  const requestId = iptRequestId(ef)
  if (deploy.rules.mode !== 'countersign') throw new Error('Not an IPT deploy')
  const tx = Transaction.fromEF(ef)
  if (tx.inputs.length === 0 || tx.inputs.length > IPT_PROPOSAL_MAX_INPUTS ||
      tx.outputs.length === 0 || tx.outputs.length > IPT_PROPOSAL_MAX_OUTPUTS) {
    throw new Error('Invalid IPT proposal size')
  }
  const inputs: string[] = []
  let amount = 0n
  for (let vin = 0; vin < tx.inputs.length; vin++) {
    const input = tx.inputs[vin]!
    if (input.sequence !== 0xffffffff) throw new Error('IPT inputs must have final sequences')
    const outpoint = `${sourceTxidOf(tx, vin)}.${input.sourceOutputIndex}`
    const source = sourceOutputOf(tx, vin)
    const known = accepted.get(outpoint)
    if (inputs.includes(outpoint) || !source || !known || source.satoshis !== 1 ||
        known.satoshis !== source.satoshis || known.lockingScript !== source.lockingScript.toHex()) {
      throw new Error('IPT input is duplicate or not in the accepted set')
    }
    const parsed = readBnt(source.lockingScript)
    if (!parsed || parsed.form !== 'held' || parsed.assetId !== deploy.assetId ||
        !sameRules(parsed.clause, deploy.rules)) throw new Error('Invalid IPT input clause')
    const chunks = input.unlockingScript?.chunks ?? []
    const signature = chunks[0]?.data
    if (chunks.length !== 1 || !signature?.length || signature[signature.length - 1] !== BNT_HOLDER_SCOPE) {
      throw new Error('IPT holder must sign with ALL|ANYONECANPAY|FORKID')
    }
    // Holder signs the original full source script, not a substituted P2PK
    // script. The issuer branch is intentionally incomplete at this stage.
    const decoded = TransactionSignature.fromChecksigFormat(signature)
    if (!decoded.verify(Hash.sha256(sighashPreimage(tx, vin, BNT_HOLDER_SCOPE)), PublicKey.fromString(parsed.clause.holder))) {
      throw new Error('Invalid IPT holder signature')
    }
    inputs.push(outpoint)
    amount += parsed.amount
  }
  let sent = 0n
  const holders: string[] = []
  for (const output of tx.outputs) {
    const parsed = readBnt(output.lockingScript)
    if (output.satoshis !== 1 || !parsed || parsed.form !== 'held' ||
        parsed.assetId !== deploy.assetId || !sameRules(parsed.clause, deploy.rules)) {
      throw new Error('Invalid IPT output clause')
    }
    sent += parsed.amount
    holders.push(parsed.clause.holder)
  }
  if (sent !== amount) throw new Error('IPT proposal does not conserve units')
  return { requestId, ef: [...ef], assetId: deploy.assetId, inputs, holders, amount }
}

/** BRC-253 §6 singleton acceptor-funded signing. Call ONLY after policy,
 * linkage and durable reservation. The fee output is consumed in full with no
 * change: holder signatures already bind every output. No broadcast occurs.
 * Funding must be reserved by the caller and its ownership checked separately.
 */
export async function signIptProposal(args: {
  ef: number[]
  deploy: BntDeploy
  accepted: ReadonlyMap<string, { satoshis: number; lockingScript: string }>
  fee: { tx: Transaction; vout: number }
  minimumFee: number
  signIssuer: (tx: Transaction, vin: number, scope: number) => Promise<number[]>
  signFee: (tx: Transaction, vin: number, scope: number) => Promise<UnlockingScript>
}): Promise<{ requestId: string; tx: Transaction; signedEf: number[] }> {
  const proposal = validateIptProposal(args.ef, args.deploy, args.accepted)
  if (args.deploy.rules.mode !== 'countersign' || args.deploy.rules.issuer.keys.length !== 1 ||
      args.deploy.rules.issuer.m !== 1) throw new Error('Shared IPT signing requires its own finality path')
  const tx = Transaction.fromEF(args.ef)
  const feeOut = args.fee.tx.outputs[args.fee.vout]
  const feeOutpoint = `${args.fee.tx.id('hex')}.${args.fee.vout}`
  const deficit = tx.outputs.length - tx.inputs.length
  if (!Number.isInteger(args.fee.vout) || args.fee.vout < 0 || !feeOut ||
      !Number.isSafeInteger(feeOut.satoshis) || !Number.isSafeInteger(args.minimumFee) ||
      args.minimumFee < 1 || feeOut.satoshis! - deficit < args.minimumFee ||
      readBnt(feeOut.lockingScript) || proposal.inputs.includes(feeOutpoint)) {
    throw new Error('Invalid IPT fee source')
  }
  tx.addInput({ sourceTransaction: args.fee.tx, sourceOutputIndex: args.fee.vout, unlockingScript: new UnlockingScript(), sequence: 0xffffffff })
  // Signing callbacks receive copies: they return signatures, never edits.
  for (let vin = 0; vin < proposal.inputs.length; vin++) {
    const holderSignature = tx.inputs[vin]!.unlockingScript!.chunks[0]!.data!
    const issuerSignature = await args.signIssuer(Transaction.fromEF(tx.toEF()), vin, BNT_ISSUER_SCOPE)
    if (issuerSignature[issuerSignature.length - 1] !== BNT_ISSUER_SCOPE) throw new Error('Invalid IPT issuer scope')
    tx.inputs[vin]!.unlockingScript = bntIssuerUnlock({ issuerSignatures: [issuerSignature], shared: false, holderSignature })
  }
  const feeVin = tx.inputs.length - 1
  tx.inputs[feeVin]!.unlockingScript = await args.signFee(Transaction.fromEF(tx.toEF()), feeVin, BNT_ISSUER_SCOPE)
  if (tx.inputs.some((_, vin) => !inputScriptValid(tx, vin))) throw new Error('Invalid completed IPT signatures')
  const signedEf = tx.toEF()
  validateIptAcceptance(args.ef, signedEf, args.deploy, args.accepted)
  return { requestId: proposal.requestId, tx, signedEf }
}

/** BRC-253 §7: the completed transaction, not the transport identity, proves
 * singleton acceptance. Bind it to the exact holder proposal before crediting
 * or broadcasting. This does not prove the fee input unspent or chain ancestry.
 */
export function validateIptAcceptance(
  proposalEf: number[],
  signedEf: number[],
  deploy: BntDeploy,
  accepted: ReadonlyMap<string, { satoshis: number; lockingScript: string }>,
): { requestId: string; tx: Transaction } {
  const proposal = validateIptProposal(proposalEf, deploy, accepted)
  if (deploy.rules.mode !== 'countersign' || deploy.rules.issuer.m !== 1 || deploy.rules.issuer.keys.length !== 1) {
    throw new Error('Not a singleton IPT acceptance')
  }
  iptRequestId(signedEf)
  const original = Transaction.fromEF(proposalEf)
  const tx = Transaction.fromEF(signedEf)
  if (tx.version !== original.version || tx.lockTime !== original.lockTime ||
      tx.inputs.length !== original.inputs.length + 1 || tx.outputs.length !== original.outputs.length ||
      tx.outputs.some((output, index) => output.satoshis !== original.outputs[index]!.satoshis ||
        output.lockingScript.toHex() !== original.outputs[index]!.lockingScript.toHex())) {
    throw new Error('IPT acceptance changed the proposal')
  }
  for (let vin = 0; vin < original.inputs.length; vin++) {
    const input = tx.inputs[vin]!
    const source = sourceOutputOf(tx, vin)
    const expected = sourceOutputOf(original, vin)!
    const chunks = input.unlockingScript?.chunks ?? []
    const holder = original.inputs[vin]!.unlockingScript!.chunks[0]!.data!
    if (sourceTxidOf(tx, vin) !== sourceTxidOf(original, vin) ||
        input.sourceOutputIndex !== original.inputs[vin]!.sourceOutputIndex ||
        input.sequence !== 0xffffffff || !source || source.satoshis !== expected.satoshis ||
        source.lockingScript.toHex() !== expected.lockingScript.toHex() ||
        chunks.length !== 3 || !chunks[0]?.data || chunks[1]?.op !== 81 ||
        chunks[0].data.at(-1) !== BNT_ISSUER_SCOPE ||
        Utils.toHex(chunks[2]?.data ?? []) !== Utils.toHex(holder)) {
      throw new Error('IPT acceptance changed an asset input')
    }
  }
  const feeVin = tx.inputs.length - 1
  const fee = sourceOutputOf(tx, feeVin)
  const feeOutpoint = `${sourceTxidOf(tx, feeVin)}.${tx.inputs[feeVin]!.sourceOutputIndex}`
  if (!fee || !Number.isSafeInteger(fee.satoshis) || fee.satoshis! < 1 || readBnt(fee.lockingScript) ||
      fee.satoshis! + original.inputs.length <= tx.outputs.reduce((sum, output) => sum + output.satoshis!, 0) ||
      proposal.inputs.includes(feeOutpoint) || tx.inputs[feeVin]!.sequence !== 0xffffffff ||
      tx.inputs.some((_, vin) => !inputScriptValid(tx, vin))) {
    throw new Error('Invalid IPT acceptance signatures or fee input')
  }
  return { requestId: proposal.requestId, tx }
}
