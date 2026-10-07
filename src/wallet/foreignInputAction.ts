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
 */
import { Beef, P2PKH, type BEEF, type CreateActionOutput, type LockingScript, type PrivateKey } from '@bsv/sdk'
import type { ActiveWallet } from './session'
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
 * Where a signed foreign-input cheque stands when this returns.
 *
 * - `accepted`: Arcade holds it and its change is selectable, so the next
 *   transaction of a run can be funded from it.
 * - `propagating`: signed and sealed; the retry queue keeps posting it. Its
 *   change stays app-held until Arcade takes it, so a run must not count on it.
 */
export type ForeignInputPropagation = 'accepted' | 'propagating'

export type ForeignInputPosted = { txid: string; propagation: ForeignInputPropagation }

/** How long a run waits for an accepted cheque's change to become selectable. */
const CHANGE_PIN_TIMEOUT_MS = 20_000
const CHANGE_PIN_POLL_MS = 250

export async function postForeignInputAction(args: {
  active: ActiveWallet
  spendKey?: PrivateKey
  inputBeef: BEEF
  inputs: ForeignInput[]
  outputs: CreateActionOutput[]
  labels: string[]
  description: string
}): Promise<ForeignInputPosted> {
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

  const [{ registerSignedSend, propagateSignedSend }, { txHadArcadeSubmitContact }] = await Promise.all([
    import('./signedSendLifecycle'),
    import('./arcadeSubmitGuard'),
  ])
  const handle = await registerSignedSend({ txid, atomicBeef, durableBody, flow: 'legacy_import' })
  const postStarted = Date.now()
  // Throws only on a proven reject, after minerSubmit has released the seal.
  const submitted = await propagateSignedSend(handle)
  const arcadeHolds = submitted.kind === 'accepted' && txHadArcadeSubmitContact(txid)
  const propagation: ForeignInputPropagation = arcadeHolds && (await changeSelectable(txid, atomicBeef)) ? 'accepted' : 'propagating'
  const doneAt = Date.now()
  appendAppLog(
    propagation === 'accepted' ? 'info' : 'warn',
    `[foreign-input] ${txid.slice(0, 12)} ${propagation} submit=${submitted.kind} done ${doneAt - startedAt}ms` +
      ` create=${createMs}ms sign=${packStarted - signStarted}ms pack=${postStarted - packStarted}ms post=${doneAt - postStarted}ms`,
  )
  return { txid, propagation }
}

/**
 * Arcade's acceptance pins the cheque in the background; the next transaction
 * of a run is funded by its change, so wait until the pin has promoted it.
 */
async function changeSelectable(txid: string, atomicBeef: number[]): Promise<boolean> {
  const { pinBroadcastLocalTx } = await import('./staleOutputRelease')
  const deadline = Date.now() + CHANGE_PIN_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await pinBroadcastLocalTx(txid, atomicBeef).catch(() => false)) return true
    await new Promise((resolve) => setTimeout(resolve, CHANGE_PIN_POLL_MS))
  }
  return false
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
