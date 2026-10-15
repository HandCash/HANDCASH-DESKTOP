import { shouldYieldChainIngestToSpend, spendNeedsStorage } from './walletCoordinator'

/**
 * The toolbox storage lock is FIFO and a call already inside it cannot be
 * interrupted. On a phone one 100-row `1sat` page held that lock for 18s, so
 * a send tapped during the page waited the rest of it. Keep each call to a
 * handful of rows, and give the event loop a turn before every call so a tap
 * can register before the next one starts.
 */

export const BASKET_SUB_READ_ROWS = 10
const SPEND_WAIT_POLL_MS = 200
const SPEND_WAIT_MAX_MS = 90_000

type ListArgs = { limit?: number; offset?: number }
type ListResult<O> = { outputs?: O[]; totalOutputs?: number }

function spendWaiting(): boolean {
  return spendNeedsStorage() || shouldYieldChainIngestToSpend()
}

async function letSpendPass(): Promise<number> {
  const started = Date.now()
  while (spendWaiting() && Date.now() - started < SPEND_WAIT_MAX_MS) {
    await new Promise((resolve) => setTimeout(resolve, SPEND_WAIT_POLL_MS))
  }
  return Date.now() - started
}

/**
 * One logical `listOutputs` page as slices of `subRows`. A negative offset is
 * newest-first (`-(skip + 1)`), as in the toolbox. The reported total is the
 * last full slice's, so the caller's page-total inference is unchanged.
 */
export async function listOutputsInSlices<A extends ListArgs, O>(
  listOutputs: (args: A) => Promise<ListResult<O>>,
  args: A,
  opts: {
    subRows?: number
    /** Each slice's rows as they land, before the whole page answers. */
    onSlice?: (rows: O[]) => void
  } = {},
): Promise<{ outputs: O[]; totalOutputs?: number; slices: number; yieldedMs: number }> {
  const limit = args.limit ?? 10
  const subRows = Math.max(1, Math.min(opts.subRows ?? BASKET_SUB_READ_ROWS, limit))
  const offset = args.offset ?? 0
  const newestFirst = offset < 0
  const skip = newestFirst ? -offset - 1 : offset
  const outputs: O[] = []
  let totalOutputs: number | undefined
  let slices = 0
  let yieldedMs = 0
  while (outputs.length < limit) {
    // A macrotask, not a microtask: the tap that starts a send is a task, and
    // it has to run before this loop takes the lock again.
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (spendWaiting()) yieldedMs += await letSpendPass()
    const want = Math.min(subRows, limit - outputs.length)
    const at = skip + outputs.length
    const page = await listOutputs({
      ...args,
      limit: want,
      offset: newestFirst ? -(at + 1) : at,
    })
    slices++
    const rows = page.outputs ?? []
    const taken = rows.slice(0, want)
    outputs.push(...taken)
    if (taken.length > 0) opts.onSlice?.(taken)
    if (rows.length < want) break
    totalOutputs = page.totalOutputs
  }
  return { outputs, totalOutputs, slices, yieldedMs }
}
