/**
 * A chain tracker that survives its primary host going down.
 *
 * `Beef.verify` needs a chain tracker to check merkle roots, and everything that
 * brings value into the wallet runs through it: internalizing an ordinal, the
 * AtomicBEEF check on a received item, the input BEEF on a legacy sweep, and the
 * monitor's proof review. The toolbox points all of that at a single Chaintracks
 * host, so when that host answers 500 the wallet stops receiving anything at all
 * — with errors ("valid AtomicBEEF", "valid Beef when factoring options.trustSelf")
 * that read like malformed data rather than an outage.
 *
 * WhatsOnChain answers the same question from block headers, so it stands in.
 * A wrong `false` would reject a genuine payment, so a primary that throws is
 * treated as no answer and the question moves on; only a real answer counts.
 */
import { WhatsOnChain, type ChainTracker } from '@bsv/sdk'
import type { Chain } from './vault'
import { appendAppLog } from './appLog'

/** Don't re-probe a host known to be down on every single merkle root. */
const PRIMARY_COOLDOWN_MS = 60_000

export function createFallbackChainTracker(
  chain: Chain,
  primary: ChainTracker | null,
): ChainTracker {
  const woc = new WhatsOnChain(chain === 'main' ? 'main' : 'test')
  let primaryDownUntil = 0
  let loggedDown = false

  const primaryUsable = () => primary != null && Date.now() >= primaryDownUntil

  function notePrimaryFailure(op: string, err: unknown): void {
    primaryDownUntil = Date.now() + PRIMARY_COOLDOWN_MS
    if (loggedDown) return
    loggedDown = true
    const msg = err instanceof Error ? err.message : String(err)
    appendAppLog('warn', `[chaintracker] primary ${op} failed (${msg}) — using WhatsOnChain`)
  }

  function notePrimaryBack(): void {
    if (!loggedDown) return
    loggedDown = false
    appendAppLog('info', '[chaintracker] primary recovered')
  }

  return {
    async isValidRootForHeight(root: string, height: number): Promise<boolean> {
      if (primaryUsable()) {
        try {
          const ok = await primary!.isValidRootForHeight(root, height)
          notePrimaryBack()
          return ok
        } catch (err) {
          notePrimaryFailure('isValidRootForHeight', err)
        }
      }
      return woc.isValidRootForHeight(root, height)
    },

    async currentHeight(): Promise<number> {
      if (primaryUsable()) {
        try {
          const h = await primary!.currentHeight()
          notePrimaryBack()
          return h
        } catch (err) {
          notePrimaryFailure('currentHeight', err)
        }
      }
      return woc.currentHeight()
    },
  }
}
