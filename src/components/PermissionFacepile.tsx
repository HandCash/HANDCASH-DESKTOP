import type { AppPermissionScope } from '../wallet/appIdentity'
import { ScopeIcon } from './ScopeIcon'

type Props = {
  scopes: readonly AppPermissionScope[]
  /** When set, each face is a button that opens that scope. */
  onSelect?: (scopeId: string) => void
  size?: 'sm' | 'md'
  className?: string
}

/** Overlapping scope icons — labels live in title/aria only, never as chip text. */
export function PermissionFacepile({ scopes, onSelect, size = 'sm', className }: Props) {
  const extra = scopes.filter((scope) => scope.id !== 'wallet-access')
  const shown = (extra.length ? extra : scopes).slice(0, 5)
  if (shown.length === 0) return null

  const iconSize = size === 'md' ? 14 : 12
  const rootClass = ['permission-facepile', size === 'md' ? 'permission-facepile--md' : null, className]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass} role="list" aria-label="Permissions">
      {shown.map((scope) => {
        const faceClass =
          scope.id === 'auto-pay'
            ? 'permission-facepile-face permission-facepile-face--accent'
            : 'permission-facepile-face'
        if (onSelect) {
          return (
            <button
              key={scope.id}
              type="button"
              role="listitem"
              className={faceClass}
              title={scope.label}
              aria-label={scope.label}
              onClick={(event) => {
                event.stopPropagation()
                event.preventDefault()
                onSelect(scope.id)
              }}
            >
              <ScopeIcon scopeId={scope.id} size={iconSize} />
            </button>
          )
        }
        return (
          <span
            key={scope.id}
            role="listitem"
            className={faceClass}
            title={scope.label}
            aria-label={scope.label}
          >
            <ScopeIcon scopeId={scope.id} size={iconSize} />
          </span>
        )
      })}
    </div>
  )
}
