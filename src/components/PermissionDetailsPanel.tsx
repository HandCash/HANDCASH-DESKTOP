import { ScopeIcon } from './ScopeIcon'
import { getPermissionScope, appDisplayName } from '../wallet/appIdentity'
import { clearAutoPaySettings, getAutoPaySettings } from '../wallet/autoPay'
import { playWalletSound } from '../wallet/soundService'

type Props = {
  origin: string
  scopeId: string
}

export function PermissionDetailsPanel({ origin, scopeId }: Props) {
  const scope = getPermissionScope(scopeId)
  const appName = appDisplayName(origin)
  const autoPay = scopeId === 'auto-pay' ? getAutoPaySettings(origin) : null

  if (!scope) {
    return <p className="connected-empty-line">Permission not found</p>
  }

  return (
    <div
      className="nav-child-panel permission-details"
      data-aeon-scope="permission-details"
      data-aeon-state={scope.id}
    >
      <div className="permission-details-hero">
        <span className="scope-icon" aria-hidden>
          <ScopeIcon scopeId={scope.id} size={18} />
        </span>
        <div className="permission-details-head">
          <strong className="permission-details-title">{scope.label}</strong>
          <span className="permission-details-sub">{appName}</span>
        </div>
      </div>

      <p className="permission-details-lede">{scope.description}</p>

      <ul className="permission-details-allows">
        {scope.allows.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      {autoPay?.enabled ? (
        <div className="permission-details-limits">
          <span>
            Limit <strong>${autoPay.maxUsd}</strong> / {autoPay.windowHours}h
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => {
              playWalletSound('soft')
              clearAutoPaySettings(origin)
            }}
          >
            Turn off
          </button>
        </div>
      ) : null}
    </div>
  )
}
