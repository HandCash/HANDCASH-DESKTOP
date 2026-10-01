import { useIssuerViews, type IssuerAsset } from '../hooks/useIssuerView'
import { IssuerIdentityMark } from './IssuerIdentityMark'

const SHOWN = 3

/**
 * Who issued the assets an action moves: each distinct issuer's BAP identity,
 * or its signing key, or an unsigned claim — never a handle.
 */
export function AssetIssuers({ assets }: { assets: readonly IssuerAsset[] }) {
  const views = useIssuerViews(assets)
  if (views.length === 0) return null
  const hidden = views.length - SHOWN
  return (
    <span className="asset-issuers" data-aeon-part="asset-issuers" data-aeon-state={hidden > 0 ? 'overflow' : 'all'}>
      {views.slice(0, SHOWN).map((view) => (
        <IssuerIdentityMark key={view.key} view={view} />
      ))}
      {hidden > 0 ? <span className="asset-issuers-more">+{hidden} more</span> : null}
    </span>
  )
}
