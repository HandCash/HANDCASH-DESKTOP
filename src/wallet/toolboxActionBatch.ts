import type { Wallet } from '@bsv/wallet-toolbox-client'

type ActionBatchController = Wallet['actionBatch']
type ActionBatchControllerClass = new (
  wallet: Wallet,
  mode: ActionBatchController['mode'],
) => ActionBatchController

/**
 * Write every `noSend` action to storage the moment it is signed.
 *
 * In `auto` mode the Toolbox stages a `noSend` createAction (≤ 8 explicit
 * inputs) in an in-memory batch that reaches storage only through a later
 * `sendWith`. `listOutputs` overlays the staged rows, so the change looks held
 * until `actionBatch.abort()` — or a reload — drops the signed action, its
 * change and the spent marks on its inputs. HandCash broadcasts signed sends
 * through `signedSendLifecycle`, never `sendWith`, so each one needs the
 * `nosend` row that `pinBroadcastLocalTx` seals.
 *
 * `SetupClient` does not forward `actionBatchMode`, and the controller class is
 * not exported; the live controller's constructor builds the legacy one.
 */
export function persistNoSendActions(wallet: Wallet): void {
  const current = wallet.actionBatch
  if (current.mode === 'legacy') return
  if (current.hasWorkspace) {
    throw new Error('Toolbox action batch already open; refusing to switch to legacy mode')
  }
  const Controller = current.constructor as ActionBatchControllerClass
  ;(wallet as { actionBatch: ActionBatchController }).actionBatch = new Controller(wallet, 'legacy')
}
