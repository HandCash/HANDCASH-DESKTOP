/**
 * Stacked market listing card — image on top, name and price below (matches
 * items-market ItemWidget), not the side-by-side fungible hero grid.
 */
import { FungibleTokenFace } from './FungibleTokenFace'
import { formatFungibleAmount } from '../wallet/fungibles'
import {
  formatPrimaryFromSats,
  formatSecondaryFromSats,
} from '../wallet/fx'
import type { DisplayCurrency } from '../wallet/displayCurrency'

export type TokenMarketListingCardProps = {
  tokenId: string
  sym: string
  iconUrl?: string
  listAmt?: number
  dec: number
  priceSats: number
  currency: DisplayCurrency
  usdPerBsv: number | null
  onClick?: () => void
}

export function TokenMarketListingCard({
  tokenId,
  sym,
  iconUrl,
  listAmt,
  dec,
  priceSats,
  currency,
  usdPerBsv,
  onClick,
}: TokenMarketListingCardProps) {
  const amountLabel =
    listAmt != null ? formatFungibleAmount(String(listAmt), dec) : null
  const Tag = onClick ? 'button' : 'div'

  return (
    <Tag
      type={onClick ? 'button' : undefined}
      className="token-market-card"
      data-aeon-scope="token-market-card"
      onClick={onClick}
    >
      <div className="token-market-card-media">
        <FungibleTokenFace tokenId={tokenId} sym={sym} iconUrl={iconUrl} size={112} />
      </div>
      <div className="token-market-card-body">
        <strong className="token-market-card-sym">{sym}</strong>
        {amountLabel ? (
          <span className="token-market-card-amt">{amountLabel} listed</span>
        ) : null}
        <span className="token-market-card-price">
          {formatPrimaryFromSats(priceSats, currency, usdPerBsv)}
        </span>
        <span className="token-market-card-secondary">
          {formatSecondaryFromSats(priceSats, currency, usdPerBsv)}
        </span>
      </div>
    </Tag>
  )
}
