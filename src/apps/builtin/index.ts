import type { ChartWalletSupport } from '../chartTypes'
import { verifyChart, type ChartVerification } from '../chartValidator'
import hashes from './hashes.json'
import messageBox from './message-box.json'
import paymentRequest from './payment-request.json'
import sendItem from './send-item.json'
import splitBill from './split-bill.json'
import tipJar from './tip-jar.json'

/** The suite as shipped: raw signed charts, in the order Settings lists them. Re-sign with `scripts/sign-app-charts.mjs`. */
export const BUILTIN_CHARTS: readonly unknown[] = [paymentRequest, tipJar, splitBill, sendItem, messageBox]

export const BUILTIN_CHART_HASHES: Readonly<Record<string, string>> = hashes

export type BuiltinApp = {
  id: string
  raw: unknown
  verification: ChartVerification
}

/** The shipped name of a built-in chart, for paths and titles; never a verification verdict. */
export function builtinChartName(id: string): string {
  const raw = BUILTIN_CHARTS.find((c) => (c as { id?: unknown }).id === id) as { name?: unknown } | undefined
  return typeof raw?.name === 'string' ? raw.name : 'App'
}

/** Every built-in chart, verified against the hash pinned for its id. */
export function builtinApps(support: ChartWalletSupport): BuiltinApp[] {
  return BUILTIN_CHARTS.map((raw) => {
    const id = String((raw as { id?: unknown }).id ?? '')
    return { id, raw, verification: verifyChart(raw, support, { expectedHash: BUILTIN_CHART_HASHES[id] ?? '-' }) }
  })
}
