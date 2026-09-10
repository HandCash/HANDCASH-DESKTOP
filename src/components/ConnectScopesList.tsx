import { CONNECT_SCOPES } from '../wallet/appIdentity'
import { ScopeIcon } from './ScopeIcon'

/** Compact Connect scope checklist — shared by modal + inline Connect UI. */
export function ConnectScopesList() {
  return (
    <div className="scope-list scope-list-compact" aria-label="Permissions requested">
      {CONNECT_SCOPES.map((scope) => (
        <div key={scope.id} className="scope-row scope-row-compact">
          <span className="scope-icon" aria-hidden>
            <ScopeIcon scopeId={scope.id} size={14} />
          </span>
          <strong>{scope.label}</strong>
        </div>
      ))}
    </div>
  )
}
