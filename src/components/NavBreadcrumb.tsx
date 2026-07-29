import { BackIcon } from './icons'

type Crumb = {
  label: string
  onClick?: () => void
}

type Props = {
  crumbs: Crumb[]
}

function backHandler(crumbs: Crumb[]): (() => void) | null {
  for (let i = crumbs.length - 2; i >= 0; i--) {
    const crumb = crumbs[i]
    if (crumb?.onClick) return crumb.onClick
  }
  return null
}

export function NavBreadcrumb({ crumbs }: Props) {
  const onBack = backHandler(crumbs)

  return (
    <div className="connected-panel-head nav-breadcrumb-head">
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
      <h2 className="nav-breadcrumb" aria-label="Breadcrumb">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          return (
            <span key={`${crumb.label}-${index}`} className="nav-breadcrumb-item">
              {index > 0 ? <span className="nav-breadcrumb-sep" aria-hidden>/</span> : null}
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
    </div>
  )
}
