/**
 * Keep toolbox monitor tasks off the storage lock while a send needs it.
 *
 * `Monitor.runOnce` runs every due task back to back and `stopTasks` is only
 * read between cycles, so the spend guard's pause cannot stop a cycle that is
 * already running. On 0.1.671 one such cycle carried `ReviewStatus` (30.6s of
 * lock) and `ReviewDoubleSpends` through an item send, between its signature
 * and its broadcast, with a BRC-29 send queued behind it.
 *
 * A skipped task stays due: the toolbox stamps `lastRunMsecsSinceEpoch` inside
 * `runScheduledTask`, which never runs, so the first cycle after the send picks
 * it up.
 */
import { spendNeedsStorage } from './walletCoordinator'

type ScheduledTask = { name?: string }
type GateableMonitor = {
  runScheduledTask?: (task: ScheduledTask) => Promise<unknown>
}

const gated = new WeakSet<object>()
const deferred = new Set<string>()

/** Install once per wallet boot, before lock tracing wraps the same method. */
export function gateMonitorTasksOnSpend(monitor: unknown): void {
  const target = monitor as GateableMonitor | null | undefined
  const original = target?.runScheduledTask
  if (!target || typeof original !== 'function' || gated.has(target)) return
  gated.add(target)
  target.runScheduledTask = async function gateTask(this: unknown, task: ScheduledTask) {
    const name = typeof task?.name === 'string' ? task.name : 'task'
    if (spendNeedsStorage()) {
      if (!deferred.has(name)) {
        deferred.add(name)
        console.info(`[monitor] ${name} deferred — a send needs the wallet`)
      }
      return undefined
    }
    if (deferred.size > 0) {
      console.info(`[monitor] resumed after send — ${deferred.size} task(s) were deferred`)
      deferred.clear()
    }
    return original.call(this, task)
  }
}

export function resetMonitorSpendGateForTests(): void {
  deferred.clear()
}
