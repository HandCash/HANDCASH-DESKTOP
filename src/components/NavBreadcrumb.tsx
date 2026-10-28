import { BackIcon } from './icons'

type Crumb = {
  label: string
  onClick?: () => void
}

type Props = {
  crumbs: Crumb[]
  /** Prefer this when display crumbs omit ancestors (desktop drops the section root). */
  onBack?: (() => void) | null
  /**
   * Desktop drops the section root (already in the titlebar) — keep a leading
   * `/` so the trail still reads as a path under that label.
   */
  leadingSep?: boolean
}

/** Nearest ancestor crumb with an action — used for the back control. */
export function navBreadcrumbBack(crumbs: Crumb[]): (() => void) | null {
  for (let i = crumbs.length - 2; i >= 0; i--) {
    const crumb = crumbs[i]
    if (crumb?.onClick) return crumb.onClick
  }
  return null
}

export function NavBreadcrumb({
  crumbs,
  onBack: onBackProp,
  leadingSep = false,
}: Props) {
  const onBack = onBackProp !== undefined ? onBackProp : navBreadcrumbBack(crumbs)

  return (
    <div className="connected-panel-head nav-breadcrumb-head">
      <h2 className="nav-breadcrumb" aria-label="Breadcrumb">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          const showSep = index > 0 || (leadingSep && index === 0)
          return (
            <span key={`${crumb.label}-${index}`} className="nav-breadcrumb-item">
              {showSep ? (
                <span
                  className={
                    leadingSep && index === 0
                      ? 'nav-breadcrumb-sep nav-breadcrumb-sep--leading'
                      : 'nav-breadcrumb-sep'
                  }
                  aria-hidden
                >
                  /
                </span>
              ) : null}
              {crumb.onClick && !last ? (
                <button type="button" className="nav-breadcrumb-link" onClick={crumb.onClick}>
                  {crumb.label}
                </button>
              ) : (
                <span className={last ? 'nav-breadcrumb-current' : undefined}>{crumb.label}</span>
              )}
            </span>
          )
        })}
      </h2>
      {onBack ? (
        <button
          type="button"
          className="nav-back-btn"
          aria-label="Back"
          title="Back"
          onClick={onBack}
        >
          <BackIcon size={18} />
        </button>
      ) : null}
    </div>
  )
}
