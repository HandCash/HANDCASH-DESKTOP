import { Telemetry, type TelemetryEvent } from '@bsv/sdk'
import type { Wallet } from '@handcash/wallet-engine'

/** Toolbox steps shorter than this are not worth a log line. */
const SLOW_SPAN_MS = 250

let nextId = 0
const hexId = (width: number): string => {
  nextId = (nextId + 1) % Number.MAX_SAFE_INTEGER
  return nextId.toString(16).padStart(width, '0')
}

const ENGINE_PHASES: Array<[RegExp, string]> = [
  [/create_action\.storage_plan$/, 'planning'],
  [/complete_signing$/, 'signing'],
  [/(?:create_action|sign_action)\.process$/, 'commit'],
]

function logSlowSpan(event: Readonly<TelemetryEvent>): void {
  if (event.type !== 'span' || event.durationMs == null) return
  if (event.durationMs < SLOW_SPAN_MS) return
  const phase = event.name.replace(/^wallet\./, '')
  const ms = Math.round(event.durationMs)
  const status = event.spanStatus && event.spanStatus !== 'ok' ? ` ${event.spanStatus}` : ''
  console.info(`[toolbox] ${phase} done ${ms}ms${status}`)
  const enginePhase = ENGINE_PHASES.find(([pattern]) => pattern.test(phase))?.[1]
  if (enginePhase) console.info(`[wallet-engine] ${enginePhase} done ${ms}ms${status}`)
}

/**
 * Log every slow engine step (`storage_plan`, `complete_signing`,
 * `verify_unlock_scripts`, `process`, …) as `[toolbox] <step> done <N>ms`.
 * Planning, signing, and commit also get a `[wallet-engine] <phase> done <N>ms`
 * line so field sessions can be compared without reading the log.
 *
 * `SetupClient.createWalletIdb` does not forward `telemetry` to the Wallet it
 * builds; the Wallet reads `this.telemetry` on every call, so replacing the
 * field after setup is equivalent to passing it to the constructor.
 */
export function traceSlowToolboxSteps(wallet: Wallet): void {
  ;(wallet as { telemetry: Telemetry }).telemetry = new Telemetry({
    enabled: true,
    sink: { capture: logSlowSpan },
    // Span ids only correlate lines in this process; the default factories
    // draw secure random bytes for every wallet call.
    traceIdFactory: () => hexId(32),
    spanIdFactory: () => hexId(16),
    correlationIdFactory: () => hexId(16),
  })
}
