/**
 * Structured wallet diagnostics for support uploads.
 *
 * Format: `[scope] event key=value key=value`
 * Use on spend failures, BRC-100 mutations, and permission edges so remote
 * `/latest` tails explain *why* without reproducing on device.
 */
import { appendAppLog, type AppLogLevel } from './appLog'
import { formatLogFields } from './logFormat'
import { fetchBalanceRead, getActiveWallet } from './session'

export type WalletBalanceSnapshot = {
  spendable: number | null
  pendingChange: number | null
  displayed: number | null
  unavailable?: string
}

const QUIET_BRC100 = new Set([
  'getVersion',
  'getNetwork',
  'getHeight',
  'getHeaderForHeight',
  'health',
  'isAuthenticated',
  'waitForAuthentication',
  'listOutputs',
  'listActions',
  'listCertificates',
  'listMessages',
  'listMessageBoxes',
  'listInputs',
  'getPublicKey',
  'getIdentity',
])

export function shouldLogBrc100Method(method: string | null | undefined): boolean {
  return !!method && !QUIET_BRC100.has(method)
}

export function logDiag(
  scope: string,
  level: AppLogLevel,
  event: string,
  fields?: Record<string, unknown>,
): void {
  const suffix = fields && Object.keys(fields).length ? ` ${formatLogFields(fields)}` : ''
  appendAppLog(level, `[${scope}] ${event}${suffix}`)
}

export async function snapshotWalletBalance(): Promise<WalletBalanceSnapshot> {
  const active = getActiveWallet()
  if (!active) {
    return { spendable: null, pendingChange: null, displayed: null, unavailable: 'locked' }
  }

  const confirmed = await fetchBalanceRead(active.wallet, { creditUnconfirmed: false })
  if (confirmed.kind === 'unavailable') {
    return {
      spendable: null,
      pendingChange: null,
      displayed: null,
      unavailable: confirmed.reason,
    }
  }

  const displayed = await fetchBalanceRead(active.wallet, { creditUnconfirmed: true })
  const spendable = confirmed.sats
  const displayedSats = displayed.kind === 'ok' ? displayed.sats : spendable
  return {
    spendable,
    pendingChange: displayedSats - spendable,
    displayed: displayedSats,
  }
}

export async function logSpendSnapshot(
  event: string,
  fields: Record<string, unknown> = {},
  level: AppLogLevel = 'warn',
): Promise<void> {
  const snap = await snapshotWalletBalance()
  logDiag('spend', level, event, { ...snap, ...fields })
}

/** Balance context + auto-upload for send/burn/market failures. */
export async function logSpendFailure(
  reason: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  await logSpendSnapshot(reason, fields, 'error')
  void import('./logShip').then((m) => m.shipAppLogsAuto('send-failure'))
}

function originHost(origin: string | undefined): string {
  const raw = (origin ?? '').trim()
  if (!raw) return 'unknown'
  try {
    return new URL(raw).host
  } catch {
    return raw.replace(/\/+$/, '').slice(0, 80)
  }
}

function parseBrc100Body(body: string): { code?: string; description?: string } {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; description?: unknown }
    return {
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
      description:
        typeof parsed.description === 'string'
          ? parsed.description.slice(0, 160)
          : undefined,
    }
  } catch {
    return {}
  }
}

function satsFromBrc100Args(method: string, args: unknown): number | undefined {
  if (method !== 'createAction' && method !== 'signAction') return undefined
  if (!args || typeof args !== 'object') return undefined
  const outputs = (args as { outputs?: Array<{ satoshis?: number }> }).outputs
  if (!Array.isArray(outputs)) return undefined
  const total = outputs.reduce((sum, row) => sum + (row?.satoshis ?? 0), 0)
  return total > 0 ? total : undefined
}

export function logBrc100Response(
  method: string,
  origin: string | undefined,
  response: { status: number; body: string },
  ms: number,
  args?: unknown,
): void {
  const parsed = parseBrc100Body(response.body)
  const ok = response.status >= 200 && response.status < 300
  const level: AppLogLevel = ok ? 'info' : response.status >= 500 ? 'error' : 'warn'
  logDiag('brc100', level, ok ? 'ok' : 'failed', {
    method,
    origin: originHost(origin),
    status: response.status,
    ms,
    ...(parsed.code ? { code: parsed.code } : {}),
    ...(parsed.description && !ok ? { detail: parsed.description } : {}),
    ...(satsFromBrc100Args(method, args) != null
      ? { sats: satsFromBrc100Args(method, args) }
      : {}),
  })
}
