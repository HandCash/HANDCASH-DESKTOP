import {
  Hash,
  LockingScript,
  PrivateKey,
  Signature,
  Spend,
  Transaction,
  TransactionSignature,
  type WalletInterface,
  type WalletProtocol,
} from '@bsv/sdk'

/** Reading, signing and script-checking one input of an Extended Format transaction. */

export function sourceOutputOf(
  tx: Transaction,
  vin: number,
): { satoshis: number; lockingScript: LockingScript } | null {
  const input = tx.inputs[vin]
  const out = input?.sourceTransaction?.outputs[input.sourceOutputIndex]
  if (!out?.lockingScript || typeof out.satoshis !== 'number') return null
  return { satoshis: out.satoshis, lockingScript: out.lockingScript }
}

export function sourceTxidOf(tx: Transaction, vin: number): string {
  const input = tx.inputs[vin]!
  return String(input.sourceTXID ?? input.sourceTransaction?.id('hex') ?? '').toLowerCase()
}

export function sighashPreimage(tx: Transaction, vin: number, scope: number): number[] {
  const input = tx.inputs[vin]
  const source = sourceOutputOf(tx, vin)
  if (!input || !source) throw new Error(`Input ${vin} has no source output`)
  return TransactionSignature.format({
    sourceTXID: sourceTxidOf(tx, vin),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, j) => j !== vin),
    inputIndex: vin,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: source.lockingScript,
    lockTime: tx.lockTime,
    scope,
  })
}

/** Checksig-format signature (DER ‖ sighash byte) over input `vin`. */
export function signInput(tx: Transaction, vin: number, key: PrivateKey, scope: number): number[] {
  const signature = key.sign(Hash.sha256(sighashPreimage(tx, vin, scope)))
  return new TransactionSignature(signature.r, signature.s, scope).toChecksigFormat()
}

/** A wallet child key named the BRC-100 way, so the wallet signs and the key never leaves it. */
export type WalletSigner = { protocolID: WalletProtocol; keyID: string; counterparty: string }

/** `signInput`, signed by BRC-100 `createSignature` over the sighash. */
export async function signInputWithWallet(
  wallet: Pick<WalletInterface, 'createSignature'>,
  tx: Transaction,
  vin: number,
  signer: WalletSigner,
  scope: number,
): Promise<number[]> {
  const { signature } = await wallet.createSignature({
    hashToDirectlySign: Hash.hash256(sighashPreimage(tx, vin, scope)),
    protocolID: signer.protocolID,
    keyID: signer.keyID,
    counterparty: signer.counterparty,
  })
  const parsed = Signature.fromDER(Array.from(signature))
  return new TransactionSignature(parsed.r, parsed.s, scope).toChecksigFormat()
}

/** Script-check input `vin` against the source output its EF claims. */
export function inputScriptValid(tx: Transaction, vin: number): boolean {
  const input = tx.inputs[vin]
  const source = sourceOutputOf(tx, vin)
  if (!input?.unlockingScript || !source) return false
  try {
    return new Spend({
      sourceTXID: sourceTxidOf(tx, vin),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: source.satoshis,
      lockingScript: source.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== vin),
      outputs: tx.outputs,
      inputIndex: vin,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    }).validate()
  } catch {
    return false
  }
}
