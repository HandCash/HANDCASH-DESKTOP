import { ScopeIcon } from './ScopeIcon'
import { getPermissionScope, appDisplayName } from '../wallet/appIdentity'
import { clearAutoPaySettings, getAutoPaySettings } from '../wallet/autoPay'
import { getItemAccess } from '../wallet/permissions'
import { playWalletSound } from '../wallet/soundService'

type Props = {
  origin: string
  scopeId: string
}

function itemGrantCopy(scopeId: string, origin: string): string | null {
  const access = getItemAccess(origin)
  if (scopeId === 'items-view') {
    if (access.view === 'none') return 'Not granted yet — approved when the app asks to list items.'
    if (access.view === 'all') return 'Granted: all collections and creators.'
    const bits: string[] = []
    if (access.collections.length) bits.push(`collections ${access.collections.join(', ')}`)
    if (access.apps.length) bits.push(`apps ${access.apps.join(', ')}`)
    if (access.creators.length) bits.push(`creators ${access.creators.join(', ')}`)
    if (access.ids.length) bits.push(`${access.ids.length} item id${access.ids.length === 1 ? '' : 's'}`)
    return `Granted (filtered): ${bits.join(' · ') || 'limited'}`
  }
  if (scopeId === 'items-send') {
    return access.canSend
      ? 'Used — every collectable send still requires per-action approval.'
      : 'Not used yet — every collectable send requires per-action approval.'
  }
  if (scopeId === 'items-receive') {
    return access.canReceive
      ? 'Granted — this app may receive collectables you approve.'
      : 'Not granted yet — approved when the app asks to receive an item.'
  }
  return null
}

export function PermissionDetailsPanel({ origin, scopeId }: Props) {
  const scope = getPermissionScope(scopeId)
  const appName = appDisplayName(origin)
  const autoPay = scopeId === 'auto-pay' ? getAutoPaySettings(origin) : null
  const itemGrant = itemGrantCopy(scopeId, origin)

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

      {itemGrant ? <p className="permission-details-lede">{itemGrant}</p> : null}

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
