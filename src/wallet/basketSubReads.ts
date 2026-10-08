import { shouldYieldChainIngestToSpend, spendNeedsStorage } from './walletCoordinator'

/**
 * The toolbox storage lock is FIFO, so a send that arrives behind one
 * 1,000-row basket read waits for all of it — 16s for bare item rows with tags
 * on a phone, right after unlock. Read the same page in short slices and let
 * a waiting send take the lock between them.
 */

export const BASKET_SUB_READ_ROWS = 100
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
    if (slices > 0 && spendWaiting()) yieldedMs += await letSpendPass()
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
