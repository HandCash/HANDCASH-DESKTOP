import { useEffect, useState } from 'react'
import { copyText } from '../wallet/clipboard'
import {
  formatFungibleAmount,
  getCachedFungibles,
  getFungible,
  listFungibles,
  subscribeFungibles,
  type FungibleToken,
} from '../wallet/fungibles'
import { shortIssuerLabel } from '../wallet/bsv21'
import { clearNavChild } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { CollectablesIcon, CopyIcon } from './icons'
import { DeferredImage } from './DeferredImage'
import { EmptyState } from './EmptyState'

type Props = {
  tokenId: string
}

function MetaRow({
  label,
  value,
  onCopy,
}: {
  label: string
  value: string
  onCopy?: () => void
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {onCopy ? (
          <button
            type="button"
            className="mono collectable-meta-copy"
            title={`Click to copy ${label.toLowerCase()}\n${value}`}
            onClick={onCopy}
          >
            {value}
          </button>
        ) : (
          <span className="mono">{value}</span>
        )}
      </dd>
    </>
  )
}

export function FungibleDetailsPanel({ tokenId }: Props) {
  const [token, setToken] = useState<FungibleToken | null>(
    () => getFungible(tokenId) ?? getCachedFungibles().find((t) => t.tokenId === tokenId) ?? null,
  )

  useEffect(() => {
    return subscribeFungibles((list) => {
      setToken(list.find((t) => t.tokenId === tokenId) ?? null)
    })
  }, [tokenId])

  useEffect(() => {
    let cancelled = false
    void listFungibles().then((list) => {
      if (cancelled) return
      setToken(list.find((t) => t.tokenId === tokenId) ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [tokenId])

  if (!token) {
    return (
      <EmptyState
        icon={<CollectablesIcon size={28} />}
        title="Token not on this device"
        body="Fungible balances live on the install that received them."
      />
    )
  }

  const amount = formatFungibleAmount(token.amt, token.dec)

  return (
    <div className="collectable-details" data-aeon-scope="fungible-details">
      <div className="collectable-details-hero">
        {token.iconUrl ? (
          <DeferredImage
            src={token.iconUrl}
            alt={token.sym}
            width={160}
            height={160}
            skeletonWidth={160}
            skeletonHeight={160}
            skeletonRadius={12}
            skeletonClassName="skeleton-qr"
            decoding="async"
          />
        ) : (
          <div className="fungible-icon-fallback" aria-hidden>
            {token.sym.slice(0, 3).toUpperCase()}
          </div>
        )}
        <h2>{token.sym}</h2>
        <p className="collectable-details-sub">{amount}</p>
        <p className="field-static-hint">
          {[
            token.issuerHandle ||
              (token.issuer ? shortIssuerLabel(token.issuer) : ''),
            token.issuerAttested ? 'Sigma signed' : '',
            token.utxoCount === 1
              ? '1 token output'
              : `${token.utxoCount} token outputs`,
            'Collect item — not spendable as BSV',
            token.spendKind === 'cosigned'
              ? 'Cosigner required to send'
              : token.spendKind === 'mixed'
                ? 'Mixed plain / cosigned tips'
                : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      <dl className="collectable-meta">
        <MetaRow
          label="Token id"
          value={token.tokenId}
          onCopy={() => {
            playWalletSound('soft')
            void copyText(token.tokenId)
          }}
        />
        <MetaRow
          label="Amount"
          value={amount}
          onCopy={() => {
            playWalletSound('soft')
            void copyText(amount)
          }}
        />
        {token.issuer ? (
          <MetaRow
            label="Issuer"
            value={
              token.issuerHandle
                ? `${token.issuerHandle} (${token.issuer})`
                : token.issuer
            }
            onCopy={() => {
              playWalletSound('soft')
              void copyText(token.issuer!)
            }}
          />
        ) : null}
        {token.issuerAttested ? (
          <MetaRow label="Attestation" value="Sigma signed (BRC-77)" />
        ) : null}
        {token.cosign?.pubkey ? (
          <MetaRow
            label="Cosigner"
            value={token.cosign.pubkey}
            onCopy={() => {
              playWalletSound('soft')
              void copyText(token.cosign!.pubkey)
            }}
          />
        ) : null}
      </dl>

      <div className="collectable-details-actions">
        <button
          type="button"
          className="secondary-btn"
          onClick={() => {
            playWalletSound('soft')
            void copyText(token.tokenId)
          }}
        >
          <CopyIcon size={16} />
          Copy token id
        </button>
        <button
          type="button"
          className="secondary-btn"
          onClick={() => {
            playWalletSound('soft')
            clearNavChild()
          }}
        >
          Back
        </button>
      </div>
    </div>
  )
}
