type Crumb = {
  label: string
  onClick?: () => void
}

type Props = {
  crumbs: Crumb[]
}

export function NavBreadcrumb({ crumbs }: Props) {
  return (
    <div className="connected-panel-head nav-breadcrumb-head">
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
