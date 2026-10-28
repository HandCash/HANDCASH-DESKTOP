import { BackIcon } from './icons'

type Crumb = {
  label: string
  onClick?: () => void
}

type TrailProps = {
  crumbs: Crumb[]
  /**
   * Desktop drops the section root (already in the titlebar) — keep a leading
   * `/` so the trail still reads as a path under that label.
   */
  leadingSep?: boolean
  className?: string
}

type Props = TrailProps & {
  /** Prefer this when display crumbs omit ancestors (desktop drops the section root). */
  onBack?: (() => void) | null
}

/** Nearest ancestor crumb with an action — used for the back control. */
export function navBreadcrumbBack(crumbs: Crumb[]): (() => void) | null {
  for (let i = crumbs.length - 2; i >= 0; i--) {
    const crumb = crumbs[i]
    if (crumb?.onClick) return crumb.onClick
  }
  return null
}

/** Path trail only — desktop titlebar (beside the root label) or compact stage. */
export function NavBreadcrumbTrail({ crumbs, leadingSep = false, className }: TrailProps) {
  return (
    <h2 className={className ?? 'nav-breadcrumb'} aria-label="Breadcrumb">
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
  )
}

/**
 * Compact stage head — same reading order as desktop:
 * path pill (`Activity / Send`) · trailing Back chrome.
 */
export function NavBreadcrumb({ crumbs, onBack: onBackProp, leadingSep = false }: Props) {
  const onBack = onBackProp !== undefined ? onBackProp : navBreadcrumbBack(crumbs)

  return (
    <div className="connected-panel-head nav-breadcrumb-head">
      <div className="wallet-nav-titlebar-pill nav-breadcrumb-path-pill">
        <NavBreadcrumbTrail
          crumbs={crumbs}
          leadingSep={leadingSep}
          className="nav-breadcrumb wallet-nav-titlebar-crumbs"
        />
      </div>
      {onBack ? (
        <div className="wallet-nav-actions-pill nav-breadcrumb-back-pill">
          <button
            type="button"
            className="wallet-nav-chrome-btn"
            aria-label="Back"
            title="Back"
            onClick={onBack}
          >
            <BackIcon size={18} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
