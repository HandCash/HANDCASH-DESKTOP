import {
  LockingScript,
  P2PKH,
  PrivateKey,
  Spend,
  Transaction,
  UnlockingScript,
} from '@bsv/sdk'

/**
 * The seller's side of every offer, market or direct: SIGHASH_SINGLE|
 * ANYONECANPAY signatures over the lot (and, on the market, the advert
 * deposit), and the check a buyer runs before signing any of its own coins.
 */

export type SellerInput = {
  vin: number
  sourceTXID: string
  sourceOutputIndex: number
  sourceTransaction?: Transaction
  sourceSatoshis: number
  lockingScript: string
  /** The output at index `vin` this signature commits to. */
  bound: { satoshis: number; lockingScript: string }
  /** BRC-48 PushDrop lock: `<pubkey> OP_CHECKSIG`, so the unlock is the signature alone. */
  checksigOnly?: boolean
}

/** Sighash byte of the first push of an unlocking script, or null. */
export function unlockSighashByte(unlockingScriptHex: string): number | null {
  const hex = unlockingScriptHex.trim().toLowerCase()
  if (!/^[0-9a-f]+$/.test(hex) || hex.length < 4) return null
  const len = parseInt(hex.slice(0, 2), 16)
  if (len < 9 || len > 0x4b || hex.length < 2 + len * 2) return null
  const sig = hex.slice(2, 2 + len * 2)
  if (!sig.startsWith('30')) return null
  return parseInt(sig.slice(-2), 16)
}

/**
 * Sign each seller input SINGLE|ANYONECANPAY. ANYONECANPAY keeps every other
 * input out of each digest and SINGLE keeps every other output out, so the
 * skeleton fills the buyer's slots with placeholders. Returns unlocking
 * script hex by vin.
 */
export async function signSellerInputs(args: {
  inputs: readonly SellerInput[]
  privateKey: PrivateKey
}): Promise<Record<number, string>> {
  const byVin = new Map(args.inputs.map((input) => [input.vin, input]))
  if (byVin.size !== args.inputs.length) throw new Error('Two seller inputs share a vin')
  const width = Math.max(...args.inputs.map((input) => input.vin)) + 1
  const skeleton = new Transaction()
  for (let vin = 0; vin < width; vin += 1) {
    const seller = byVin.get(vin)
    skeleton.addInput({
      sourceTXID: seller ? seller.sourceTXID.toLowerCase() : '00'.repeat(32),
      sourceOutputIndex: seller?.sourceOutputIndex ?? 0,
      ...(seller?.sourceTransaction ? { sourceTransaction: seller.sourceTransaction } : {}),
      sequence: 0xffffffff,
    })
  }
  for (let vout = 0; vout < width; vout += 1) {
    const bound = byVin.get(vout)?.bound
    skeleton.addOutput({
      satoshis: bound?.satoshis ?? 0,
      lockingScript: LockingScript.fromHex(bound?.lockingScript ?? '6a'),
    })
  }
  const unlocks: Record<number, string> = {}
  for (const input of args.inputs) {
    const full = await new P2PKH()
      .unlock(
        args.privateKey,
        'single',
        true,
        input.sourceSatoshis,
        LockingScript.fromHex(input.lockingScript),
      )
      .sign(skeleton, input.vin)
    const unlocking = input.checksigOnly ? new UnlockingScript(full.chunks.slice(0, 1)) : full
    const hex = unlocking.toHex()
    if (!hex) throw new Error(`Seller signature for input ${input.vin} is missing`)
    unlocks[input.vin] = hex
  }
  return unlocks
}

/**
 * Script-check a seller unlock inside the transaction the buyer is about to
 * sign. A signature over a different bound output, or a different input, is
 * refused here, before any of the buyer's coins are signed.
 */
export function sellerUnlockValid(args: {
  tx: Transaction
  vin: number
  sourceSatoshis: number
  lockingScript: string
  unlockingScript: string
}): boolean {
  const input = args.tx.inputs[args.vin]
  if (!input) return false
  try {
    return new Spend({
      sourceTXID: String(input.sourceTXID),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: args.sourceSatoshis,
      lockingScript: LockingScript.fromHex(args.lockingScript),
      transactionVersion: args.tx.version,
      otherInputs: [],
      allInputs: args.tx.inputs,
      unlockingScript: UnlockingScript.fromHex(args.unlockingScript),
      inputSequence: input.sequence ?? 0xffffffff,
      inputIndex: args.vin,
      outputs: args.tx.outputs,
      lockTime: args.tx.lockTime,
      isRelaxed: true,
    } as ConstructorParameters<typeof Spend>[0]).validate()
  } catch {
    return false
  }
}
