import { Monitor } from '../Monitor'
import { WalletMonitorTask } from './WalletMonitorTask'

/**
 * Notify Transaction records of changes in ProvenTxReq records they may have missed.
 *
 * The `notified` property flags reqs that do not need to be checked.
 *
 * Looks for aged Transactions with provenTxId with status != 'completed', sets status to 'completed'.
 *
 * Looks for reqs with 'invalid' status that have corresonding transactions with status other than 'failed'.
 */
export class TaskReviewStatus extends WalletMonitorTask {
  static readonly taskName = 'ReviewStatus'

  /**
   * Set to true to trigger running this task
   */
  private static checkNowRequested = false
  static get checkNow (): boolean { return this.checkNowRequested }
  static set checkNow (value: boolean) { this.checkNowRequested = value }

  constructor (
    monitor: Monitor,
    public triggerMsecs = 1000 * 60 * 15,
    public agedMsecs = 1000 * 60 * 5
  ) {
    super(monitor, TaskReviewStatus.taskName)
  }

  trigger (nowMsecsSinceEpoch: number): { run: boolean } {
    return {
      run: this.triggerMsecs > 0 && nowMsecsSinceEpoch - this.lastRunMsecsSinceEpoch > this.triggerMsecs
    }
  }

  /**
   * Each phase takes the storage lock on its own, and UTXO checks against
   * external services run holding none: one review holding it throughout
   * kept a phone's sends waiting 66s behind a single run.
   */
  async runTask (): Promise<string> {
    let log = ''
    const timed = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
      const started = Date.now()
      try {
        return await work()
      } finally {
        const ms = Date.now() - started
        if (ms > 250) console.info(`[monitor] ReviewStatus ${phase} done ${ms}ms`)
      }
    }

    // Reconcile completed-but-unnotified proof requests first. This path
    // restores failed transaction bookkeeping before completion; the generic
    // reviewStatus SQL repair cannot reconstruct that state after changing a
    // failed row directly to completed.
    const { sp: provider, pending } = await timed('read', async () =>
      await this.storage.runAsStorageProvider(async sp => ({ sp, pending: await sp.completedProvenTxReqsToReconcile() }))
    )
    for (const { req, outputs } of pending) {
      try {
        const verdicts = await timed('utxo-check', async () => await provider.proofRecoveryVerdicts(outputs))
        log += await timed('reconcile', async () =>
          await this.storage.runAsStorageProvider(async sp => await sp.reconcileCompletedProvenTxReq(req, verdicts))
        )
      } catch (err) {
        log += `completed req ${req.provenTxReqId} deferred: ${err instanceof Error ? err.message : String(err)}\n`
      }
    }

    const agedLimit = new Date(Date.now() - this.agedMsecs)
    const review = await timed('review', async () =>
      await this.storage.runAsStorageProvider(async sp => await sp.reviewStatus({ agedLimit }))
    )
    log += review.log

    return log
  }
}
