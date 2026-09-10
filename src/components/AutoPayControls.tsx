import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_AUTO_PAY_MAX_USD,
  DEFAULT_AUTO_PAY_WINDOW_HOURS,
  getAutoPaySettings,
  type AutoPayChoice,
} from '../wallet/autoPay'
import {
  formatSpendingAuthorizationLabel,
  type SpendingAuthorizationDeclaration,
} from '../wallet/spendingAuthorization'

export type { AutoPayChoice }

type AutoPayFormState = {
  enabled: boolean
  maxUsd: string
  windowHours: string
  maxUsdValid: boolean
  hoursValid: boolean
  /** True when dollar/hour fields are required and invalid. */
  limitsInvalid: boolean
  setEnabled: (next: boolean) => void
  setMaxUsd: (next: string) => void
  setWindowHours: (next: string) => void
  /** Load (or reset) form from stored settings for an origin. */
  loadFromOrigin: (origin: string | undefined) => void
  /** Choice to pass to setAutoPaySettings / onAllow. */
  toChoice: () => AutoPayChoice
}

/** Shared Auto-pay form state for Connect + action permission surfaces. */
export function useAutoPayForm(): AutoPayFormState {
  const [enabled, setEnabled] = useState(false)
  const [maxUsd, setMaxUsd] = useState(String(DEFAULT_AUTO_PAY_MAX_USD))
  const [windowHours, setWindowHours] = useState(String(DEFAULT_AUTO_PAY_WINDOW_HOURS))

  const loadFromOrigin = useCallback((origin: string | undefined) => {
    const existing = getAutoPaySettings(origin)
    if (existing?.enabled) {
      setEnabled(true)
      setMaxUsd(String(existing.maxUsd))
      setWindowHours(String(existing.windowHours))
      return
    }
    setEnabled(false)
    setMaxUsd(String(DEFAULT_AUTO_PAY_MAX_USD))
    setWindowHours(String(DEFAULT_AUTO_PAY_WINDOW_HOURS))
  }, [])

  const parsedMaxUsd = Number.parseFloat(maxUsd)
  const parsedHours = Number.parseFloat(windowHours)
  const maxUsdValid = Number.isFinite(parsedMaxUsd) && parsedMaxUsd > 0
  const hoursValid = Number.isFinite(parsedHours) && parsedHours > 0

  const toChoice = useCallback(
    (): AutoPayChoice => ({
      enabled,
      maxUsd: maxUsdValid ? parsedMaxUsd : DEFAULT_AUTO_PAY_MAX_USD,
      windowHours: hoursValid ? Math.round(parsedHours) : DEFAULT_AUTO_PAY_WINDOW_HOURS,
    }),
    [enabled, hoursValid, maxUsdValid, parsedHours, parsedMaxUsd],
  )

  return {
    enabled,
    maxUsd,
    windowHours,
    maxUsdValid,
    hoursValid,
    limitsInvalid: enabled && (!maxUsdValid || !hoursValid),
    setEnabled,
    setMaxUsd,
    setWindowHours,
    loadFromOrigin,
    toChoice,
  }
}

type ControlsProps = {
  appName: string
  enabled: boolean
  maxUsd: string
  windowHours: string
  onEnabledChange: (next: boolean) => void
  onMaxUsdChange: (next: string) => void
  onWindowHoursChange: (next: string) => void
  /**
   * When set, hide $ / hours and show the monthly sat grant instead
   * (BRC spendingAuthorization on Connect).
   */
  monthlyCap?: SpendingAuthorizationDeclaration | null
}

/** Auto-pay checkbox + optional dollar/hour limits (or monthly-cap note). */
export function AutoPayControls({
  appName,
  enabled,
  maxUsd,
  windowHours,
  onEnabledChange,
  onMaxUsdChange,
  onWindowHoursChange,
  monthlyCap = null,
}: ControlsProps) {
  const useMonthlyCap = Boolean(monthlyCap)

  return (
    <div className="auto-pay" data-aeon-part="auto-pay">
      <label className="auto-pay-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
        <span>
          Auto-pay from <strong>{appName}</strong>
        </span>
      </label>

      {enabled && !useMonthlyCap ? (
        <div className="auto-pay-params" role="group" aria-label="Auto-pay limits">
          <label className="auto-pay-field">
            <span className="auto-pay-prefix">$</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              value={maxUsd}
              onChange={(e) => onMaxUsdChange(e.target.value)}
              aria-label="Maximum dollars"
            />
          </label>
          <span className="auto-pay-sep">every</span>
          <span className="auto-pay-unit">
            <label className="auto-pay-field auto-pay-field-hours">
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={windowHours}
                onChange={(e) => onWindowHoursChange(e.target.value)}
                aria-label="Hours"
              />
            </label>
            <span className="auto-pay-sep">hours</span>
          </span>
        </div>
      ) : null}

      {enabled && useMonthlyCap && monthlyCap ? (
        <p className="permission-note auto-pay-cap-note">
          Within {formatSpendingAuthorizationLabel(monthlyCap)}.
        </p>
      ) : null}
    </div>
  )
}

/** Footnote under Connect scopes + Auto-pay. */
export function connectPermissionNote(
  spendingAuthorization: SpendingAuthorizationDeclaration | null | undefined,
  autoPayEnabled: boolean,
): string {
  const receive =
    'Incoming plain BSV is accepted automatically. Disconnect anytime in Connected apps.'
  if (spendingAuthorization) {
    const cap = formatSpendingAuthorizationLabel(spendingAuthorization)
    const pay = autoPayEnabled
      ? 'Matching outgoing payments stay silent within that monthly cap.'
      : 'Outgoing payments still need approval unless you enable Auto-pay.'
    return `${cap}. ${pay} ${receive}`
  }
  if (autoPayEnabled) {
    return `Matching outgoing payments stay silent within your Auto-pay limits. Items still need separate approval. ${receive}`
  }
  return `Outgoing payments and items still need separate approval. ${receive}`
}

/** Whether this action prompt should offer Auto-pay (plain BSV pay only). */
export function isBsvPaymentAction(pending: {
  kind?: string
  method: string
  title?: string
}): boolean {
  if (pending.kind === 'connect') return false
  if (pending.method !== 'createAction' && pending.method !== 'signAction') return false
  if (
    pending.title === 'Send item' ||
    pending.title === 'Confirm item send' ||
    pending.title === 'Release item' ||
    pending.title === 'Send token' ||
    pending.title === 'Confirm token send' ||
    pending.title === 'Release token' ||
    pending.title === 'Mint token' ||
    pending.title === 'Mint item'
  ) {
    return false
  }
  return true
}

/** Keep hook export usable when a parent only needs origin sync. */
export function useLoadAutoPayOnOrigin(
  origin: string | undefined,
  id: number | undefined,
  loadFromOrigin: (origin: string | undefined) => void,
): void {
  useEffect(() => {
    loadFromOrigin(origin)
  }, [origin, id, loadFromOrigin])
}
