/**
 * One transaction spending outputs locked to keys this wallet does not hold
 * (an imported phrase, a HandCash export), funded by this wallet's change.
 *
 * The Toolbox adds funding and change and signs those; each foreign input is
 * signed here with its own key against its real locking script. The signed
 * transaction is a cheque like any other send: `noSend` keeps the Toolbox from
 * queueing a broadcast of its own, and `signedSendLifecycle` seals, archives,
 * posts and follows it. Before signing completes nothing has left the device,
 * so a failure releases the action; after it, only a proven reject does.
 *
 * Like a payment, the spend region covers signing and registration only
 * (`signForeignInputAction`). A run then settles each cheque outside it
 * (`settleForeignInputAction`), so a slow post never holds the wallet.
 */
import { Beef, P2PKH, type BEEF, type CreateActionOutput, type LockingScript, type PrivateKey } from '@bsv/sdk'
import type { ActiveWallet } from './session'
import type { MinerSubmitResult } from './minerSubmit'
import { appendAppLog } from './appLog'
import { migratePackage, migrateRetryBody, migrateTipPostBytes } from './itemMigrateBundle'

/** A source output signed by a foreign key against its real locking script. */
export type ForeignInput = {
  outpoint: string
  txid: string
  vout: number
  /** Real value of the source output — the sighash amount must match exactly. */
  satoshis: number
  /** Real locking script — the sighash scriptCode must be the whole script. */
  sourceLock: LockingScript
  description: string
  /** Key for this input; defaults to the action's `spendKey`. */
  spendKey?: PrivateKey
}

/**
 * Where a signed foreign-input cheque stands once it is settled.
 *
 * - `accepted`: Arcade holds it and its change is selectable, so the next
 *   transaction of a run can be funded from it.
 * - `propagating`: signed and sealed; the retry queue keeps posting it. Its
 *   change stays app-held until Arcade takes it, so a run must not count on it.
 */
export type ForeignInputPropagation = 'accepted' | 'propagating'

export type ForeignInputPosted = { txid: string; propagation: ForeignInputPropagation }

/**
 * A registered cheque whose common propagation has started. The spend region
 * ends here, as it does for every payment: posting and waiting for Arcade
 * hold no wallet lock.
 */
export type ForeignInputSigned = {
  txid: string
  atomicBeef: number[]
  /** The common miner submit; rejects only on a proven reject. */
  submitted: Promise<MinerSubmitResult>
  startedAt: number
  /** create / sign / pack / register, for the settle log line. */
  phases: string
}

export function isForeignInputSigned(value: unknown): value is ForeignInputSigned {
  const signed = value as Partial<ForeignInputSigned> | null
  return typeof signed?.txid === 'string' && Array.isArray(signed.atomicBeef) && signed.submitted instanceof Promise
}

export async function signForeignInputAction(args: {
  active: ActiveWallet
  spendKey?: PrivateKey
  inputBeef: BEEF
  inputs: ForeignInput[]
  outputs: CreateActionOutput[]
  labels: string[]
  description: string
}): Promise<ForeignInputSigned> {
  const { active, inputs } = args
  if (inputs.some((input) => !(input.spendKey ?? args.spendKey))) {
    throw new Error('Every foreign input needs a key to sign it')
  }
  const startedAt = Date.now()
  const car = await active.wallet.createAction({
    inputBEEF: args.inputBeef,
    inputs: inputs.map((input) => ({
      outpoint: input.outpoint,
      unlockingScriptLength: 108,
      inputDescription: input.description,
    })),
    outputs: args.outputs,
    labels: args.labels,
    description: args.description,
    options: {
      trustSelf: 'known',
      signAndProcess: false,
      noSend: true,
      // Outputs carry per-item provenance or a token's exact amount; order must survive.
      randomizeOutputs: false,
    },
  })
  const createMs = Date.now() - startedAt

  const signStarted = Date.now()
  let signed: { txid: string; atomic: number[] }
  try {
    signed = await signForeignInputs(active, inputs, args.spendKey, car)
  } catch (err) {
    // An unsigned action keeps its reserved change and still lists its outputs,
    // so a failed migrate showed in Collect as real collectables until review
    // failed it. `noSend` means nothing was broadcast: releasing it is the end.
    const reference = car.signableTransaction?.reference
    if (reference) {
      try {
        await active.wallet.abortAction({ reference })
      } catch (abortErr) {
        appendAppLog(
          'warn',
          `[foreign-input] could not abort unsigned action of ${inputs.length} input(s): ${
            abortErr instanceof Error ? abortErr.message : String(abortErr)
          }`,
        )
      }
    }
    throw err
  }

  const packStarted = Date.now()
  const { txid } = signed
  const packed = new Beef()
  packed.mergeBeef(args.inputBeef)
  packed.mergeBeef(signed.atomic)
  packed.atomicTxid = undefined
  const atomicBeef = migratePackage(packed, txid)
  const durableBody = migrateRetryBody(atomicBeef, txid)
  const efBytes = inputs.reduce((sum, input) => sum + migrateTipPostBytes(input.sourceLock.toBinary().length), 0)
  appendAppLog(
    'info',
    `[foreign-input] package ${txid.slice(0, 12)} inputs=${inputs.length} bytes=${atomicBeef.length}` +
      ` durable=${durableBody.length} ef=${efBytes} in=${args.inputBeef.length}`,
  )

  const [{ registerSignedSend, propagateSignedSend }, { noteForeignInputs }] = await Promise.all([
    import('./signedSendLifecycle'),
    import('./staleOutputRelease'),
  ])
  noteForeignInputs(inputs.map((input) => `${input.txid}.${input.vout}`))
  const registerStarted = Date.now()
  const handle = await registerSignedSend({ txid, atomicBeef, durableBody, flow: 'legacy_import' })
  const submitted = propagateSignedSend(handle)
  // Settled by the run; a proven reject has already rewritten the cheque.
  submitted.catch(() => undefined)
  return {
    txid,
    atomicBeef,
    submitted,
    startedAt,
    phases:
      `create=${createMs}ms sign=${packStarted - signStarted}ms pack=${registerStarted - packStarted}ms` +
      ` register=${Date.now() - registerStarted}ms`,
  }
}

/**
 * Wait, outside the spend region, for what the common flow did with the
 * cheque. Throws only on a proven reject; `propagating` means Arcade has not
 * taken it yet and the retry queue still holds it.
 */
export async function settleForeignInputAction(signed: ForeignInputSigned): Promise<ForeignInputPosted> {
  const { txid, atomicBeef } = signed
  const postStarted = Date.now()
  const result = await signed.submitted
  const submittedAt = Date.now()
  const { awaitChainedLegFunding } = await import('./signedSendLifecycle')
  const propagation: ForeignInputPropagation = (await awaitChainedLegFunding(txid, atomicBeef)) ? 'accepted' : 'propagating'
  const doneAt = Date.now()
  appendAppLog(
    propagation === 'accepted' ? 'info' : 'warn',
    `[foreign-input] ${txid.slice(0, 12)} ${propagation} submit=${result.kind} done ${doneAt - signed.startedAt}ms` +
      ` ${signed.phases} post=${submittedAt - postStarted}ms pin=${doneAt - submittedAt}ms`,
  )
  return { txid, propagation }
}

function asBytes(tx: unknown): number[] {
  if (Array.isArray(tx) && tx.every((n) => typeof n === 'number')) return tx as number[]
  if (tx instanceof Uint8Array) return Array.from(tx)
  return []
}

async function signForeignInputs(
  active: ActiveWallet,
  inputs: ForeignInput[],
  spendKey: PrivateKey | undefined,
  car: Awaited<ReturnType<ActiveWallet['wallet']['createAction']>>,
): Promise<{ txid: string; atomic: number[] }> {
  let txid = (car.txid ?? '').toLowerCase()
  let atomic = asBytes(car.tx)
  if (car.signableTransaction) {
    const stBeef = Beef.fromBinary(asBytes(car.signableTransaction.tx))
    const wanted = new Map(inputs.map((input) => [`${input.txid}.${input.vout}`, input]))
    let unsignedTx
    const inputIndexes = new Map<number, ForeignInput>()
    for (const stbtx of stBeef.txs) {
      if (stbtx.tx == null) continue
      for (let i = 0; i < stbtx.tx.inputs.length; i++) {
        const inp = stbtx.tx.inputs[i]
        const input = wanted.get(`${String(inp.sourceTXID).toLowerCase()}.${inp.sourceOutputIndex}`)
        if (!input) continue
        unsignedTx = stbtx.tx
        inputIndexes.set(i, input)
      }
      if (unsignedTx != null) break
    }
    if (unsignedTx == null || inputIndexes.size !== inputs.length) {
      throw new Error('Could not find every foreign input to sign')
    }
    // Sats flow first-in first-out: tip i must be input i for its inscribed sat
    // to land in output i. A funding input ahead of a tip would carry the
    // inscription into change, so a reordered layout is never signed.
    if (!inputs.every((input, index) => inputIndexes.get(index) === input)) {
      throw new Error('The wallet reordered the foreign inputs; refusing to sign')
    }
    // Ordinal tips are P2PKH ‖ inscription ‖ Sigma, so the sighash scriptCode
    // must be the *whole* locking script, not a bare P2PKH.
    for (const [index, input] of inputIndexes) {
      unsignedTx.inputs[index]!.unlockingScriptTemplate = new P2PKH().unlock(
        (input.spendKey ?? spendKey)!,
        'all',
        false,
        input.satoshis,
        input.sourceLock,
      )
    }
    await unsignedTx.sign()
    const spends: Record<number, { unlockingScript: string }> = {}
    for (const index of inputIndexes.keys()) {
      spends[index] = { unlockingScript: unsignedTx.inputs[index]!.unlockingScript!.toHex() }
    }
    const sar = await active.wallet.signAction({ reference: car.signableTransaction.reference, spends })
    txid = (sar.txid ?? '').toLowerCase()
    atomic = asBytes(sar.tx)
  }
  if (!/^[0-9a-f]{64}$/.test(txid) || atomic.length === 0) {
    throw new Error('Signing produced no transaction body')
  }
  return { txid, atomic }
}
