import { LockingScript, OP, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { inputScriptValid } from '../txInputs'
import { outpointBytes } from './payload'
import { bntBeaconLock, type BntRules } from './script'

type Coin = { tx: Transaction; vout: number }

/**
 * BRC-253 §9: construct a singleton issuer refresh or retirement.
 * The host reserves both inputs and persists the signed result before broadcast.
 * This does not establish unspentness, mining, issuer policy or permission to sign.
 */
export async function signIptBeaconSpend(args: {
  rules: Extract<BntRules, { mode: 'countersign' }>
  genesis: string
  beacon: Coin
  fee: Coin
  retire?: boolean
  minimumFee: number
  signIssuer(tx: Transaction, vin: number): Promise<number[]>
  signFee(tx: Transaction, vin: number): Promise<UnlockingScript>
}): Promise<Transaction> {
  // Snapshot before invoking host callbacks; never expose the transaction being built.
  const rules = structuredClone(args.rules)
  const genesis = args.genesis
  const retire = args.retire === true
  const minimumFee = args.minimumFee
  const beacon = { tx: Transaction.fromHex(args.beacon.tx.toHex()), vout: args.beacon.vout }
  const fee = { tx: Transaction.fromHex(args.fee.tx.toHex()), vout: args.fee.vout }
  if (rules.issuer.m !== 1 || rules.issuer.keys.length !== 1) throw new Error('shared beacon signing requires quorum coordination')
  if (!/^[0-9a-f]{64}_(0|[1-9][0-9]*)$/.test(genesis)) throw new Error('invalid genesis beacon')
  if (!Number.isSafeInteger(minimumFee) || minimumFee < 1) throw new Error('invalid beacon fee')
  const script = bntBeaconLock(rules)
  const source = beacon.tx.outputs[beacon.vout]
  const funding = fee.tx.outputs[fee.vout]
  if (!Number.isSafeInteger(beacon.vout) || beacon.vout < 0 || source?.satoshis !== 1 || source.lockingScript.toHex() !== script.toHex()) throw new Error('invalid beacon source')
  if (!Number.isSafeInteger(fee.vout) || fee.vout < 0 || !funding || !Number.isSafeInteger(funding.satoshis) || funding.satoshis! < minimumFee) throw new Error('insufficient beacon funding')
  if (funding.lockingScript.toHex() === script.toHex()) throw new Error('a beacon cannot fund its own refresh')
  if (beacon.tx.id('hex') === fee.tx.id('hex') && beacon.vout === fee.vout) throw new Error('duplicate beacon input')
  const tx = new Transaction()
  for (const coin of [beacon, fee]) tx.addInput({ sourceTransaction: coin.tx, sourceOutputIndex: coin.vout, sequence: 0xffffffff, unlockingScript: new UnlockingScript() })
  tx.addOutput({ satoshis: 1, lockingScript: script })
  if (retire) tx.addOutput({ satoshis: 0, lockingScript: new LockingScript().writeOpCode(OP.OP_0).writeOpCode(OP.OP_RETURN).writeBin(Utils.toArray('ipt retire', 'utf8')).writeBin(outpointBytes(genesis)) })
  const signature = await args.signIssuer(Transaction.fromEF(tx.toEF()), 0)
  if (signature.length < 2 || signature[signature.length - 1] !== 0x41) throw new Error('beacon issuer must sign ALL|FORKID')
  tx.inputs[0]!.unlockingScript = new UnlockingScript().writeBin([...signature]).writeOpCode(OP.OP_1)
  tx.inputs[1]!.unlockingScript = UnlockingScript.fromHex((await args.signFee(Transaction.fromEF(tx.toEF()), 1)).toHex())
  if (!inputScriptValid(tx, 0) || !inputScriptValid(tx, 1)) throw new Error('invalid completed beacon signatures')
  return tx
}
