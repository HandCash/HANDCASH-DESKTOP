import { useEffect, useMemo, useState } from 'react'
import { Accordion } from '@aeon-ui/react'
import { CollectionViewToggle } from './CollectionViewToggle'
import { DeferredImage } from './DeferredImage'
import { CollectableVerifyMark } from './CollectableVerifyMark'
import { CollectableSendingMark } from './CollectableSendingMark'
import { useChunkedCount } from './useChunkedCount'
import {
  getCollectionView,
  subscribeCollectionView,
  type CollectionView,
} from '../wallet/collectionView'
import {
  areCollectablesHydrated,
  getCollectablePageStatus,
  getCachedCollectables,
  listCollectables,
  loadMoreCollectables,
  subscribeCollectables,
  type Collectable,
} from '../wallet/collectables'
import {
  groupCollectables,
  groupQuantityLabel,
  type CollectableGroup,
} from '../wallet/collectableGroups'
import {
  getVerificationProgress,
  isOutpointVerifying,
  subscribeVerificationProgress,
  type VerificationProgress,
} from '../wallet/verificationProgress'
import {
  getPaymentProgress,
  isOutpointSending,
  subscribePaymentProgress,
} from '../wallet/paymentProgress'
import { openCollectableDetails, openSendCollectable, openFungibleDetails, openSendFungible, openBurnFungible } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { EmptyState } from './EmptyState'
import { FungibleTokenFace } from './FungibleTokenFace'
import { CollectablesIcon, FireIcon, SendIcon } from './icons'
import {
  areFungiblesHydrated,
  formatFungibleAmount,
  getCachedFungibles,
  listFungibles,
  subscribeFungibles,
  type FungibleToken,
} from '../wallet/fungibles'
import { shortIssuerLabel } from '../wallet/bsv21'
import { shortOriginLabel } from '../wallet/colourCoins'

/** Paint a few cards per frame so opening Collect does not block the UI. */
const RENDER_CHUNK = 6

function CollectableGridItem({
  item,
  verifying,
  sending,
}: {
  item: Collectable
  verifying: boolean
  sending: boolean
}) {
  return (
    <li
      className="collection-grid-card collectable-card"
      data-sending={sending ? 'true' : undefined}
    >
      <button
        type="button"
        className="collection-grid-main collectable-main"
        onClick={() => {
          playWalletSound('soft')
          openCollectableDetails(item.outpoint)
        }}
      >
        <div className="collectable-media">
          <DeferredImage
            src={item.imageUrl}
            alt={item.name}
            width={120}
            height={120}
            skeletonWidth={120}
            skeletonHeight={120}
            skeletonRadius={8}
            skeletonClassName="skeleton-qr"
            decoding="async"
            fallback={
              <span className="collectable-media-fallback" aria-hidden>
                <CollectablesIcon size={36} />
              </span>
            }
          />
          <CollectableSendingMark sending={sending} />
          <CollectableVerifyMark verifying={verifying} outpoint={item.outpoint} />
        </div>
        <strong className="collection-grid-name" title={item.name}>
          {item.name}
        </strong>
        {item.app ? (
          <span className="collection-grid-host" title={item.app}>
            {item.app}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="collectable-send-btn"
        title={sending ? `Sending ${item.name}` : `Send ${item.name}`}
        aria-label={sending ? `Sending ${item.name}` : `Send ${item.name}`}
        disabled={sending}
        onClick={(e) => {
          e.stopPropagation()
          playWalletSound('soft')
          openSendCollectable(item.outpoint)
        }}
      >
        <SendIcon size={14} />
        {sending ? 'Sending' : 'Send'}
      </button>
    </li>
  )
}

function CollectableListItem({
  item,
  verifying,
  sending,
}: {
  item: Collectable
  verifying: boolean
  sending: boolean
}) {
  return (
    <li
      className="connected-app-row collectable-row"
      data-sending={sending ? 'true' : undefined}
    >
      <button
        type="button"
        className="connected-app-main collectable-row-main"
        onClick={() => {
          playWalletSound('soft')
          openCollectableDetails(item.outpoint)
        }}
      >
        <div className="collectable-media collectable-media-sm">
          <DeferredImage
            src={item.imageUrl}
            alt={item.name}
            width={48}
            height={48}
            skeletonWidth={48}
            skeletonHeight={48}
            skeletonRadius={6}
            skeletonClassName="skeleton-qr"
            decoding="async"
            fallback={
              <span className="collectable-media-fallback" aria-hidden>
                <CollectablesIcon size={22} />
              </span>
            }
          />
          <CollectableSendingMark sending={sending} />
          <CollectableVerifyMark verifying={verifying} outpoint={item.outpoint} />
        </div>
        <div className="connected-app-body">
          <strong className="connected-app-name">{item.name}</strong>
          {item.app ? (
            <span className="connected-app-host">{item.app}</span>
          ) : null}
        </div>
      </button>
      <button
        type="button"
        className="collectable-send-btn collectable-send-btn--row"
        title={sending ? `Sending ${item.name}` : `Send ${item.name}`}
        aria-label={sending ? `Sending ${item.name}` : `Send ${item.name}`}
        disabled={sending}
        onClick={() => {
          playWalletSound('soft')
          openSendCollectable(item.outpoint)
        }}
      >
        <SendIcon size={14} />
        {sending ? 'Sending' : 'Send'}
      </button>
    </li>
  )
}


/** Grid or list of individual items — used loose and inside a collection. */
function CollectableItems({
  items,
  view,
  verification,
  sendingOutpoint,
}: {
  items: Collectable[]
  view: CollectionView
  verification: VerificationProgress
  sendingOutpoint: string | null
}) {
  const shownCount = useChunkedCount(items.length, RENDER_CHUNK)
  const visible = items.slice(0, shownCount)
  const Item = view === 'grid' ? CollectableGridItem : CollectableListItem

  return (
    <ul className={view === 'grid' ? 'collection-grid' : 'connected-app-list'}>
      {visible.map((item) => (
        <Item
          key={item.outpoint}
          item={item}
          verifying={isOutpointVerifying(item.outpoint, verification)}
          sending={sendingOutpoint != null && isOutpointSending(item.outpoint)}
        />
      ))}
    </ul>
  )
}

/** Stacked art for a folded collection. Faces defer like any other bitmap. */
function CollectableFacepile({ group }: { group: CollectableGroup }) {
  return (
    <span className="collect-facepile" aria-hidden>
      {group.faces.map((face) => (
        <span key={face.outpoint} className="collect-facepile-face">
          <DeferredImage
            src={face.imageUrl}
            alt=""
            width={40}
            height={40}
            skeletonWidth={40}
            skeletonHeight={40}
            skeletonRadius={999}
            skeletonClassName="skeleton-qr"
            decoding="async"
            fallback={
              <span className="collectable-media-fallback" aria-hidden>
                <CollectablesIcon size={18} />
              </span>
            }
          />
        </span>
      ))}
      {group.overflow > 0 ? (
        <span className="collect-facepile-more">+{group.overflow.toLocaleString()}</span>
      ) : null}
    </span>
  )
}

function CollectionGroupItem({
  group,
  view,
  verification,
  sendingOutpoint,
}: {
  group: CollectableGroup
  view: CollectionView
  verification: VerificationProgress
  sendingOutpoint: string | null
}) {
  const sendingHere =
    sendingOutpoint != null && group.items.some((item) => isOutpointSending(item.outpoint))

  return (
    <Accordion.Item
      value={group.key}
      className="collect-collection"
      data-sending={sendingHere ? 'true' : undefined}
    >
      <Accordion.ItemTrigger value={group.key} className="collect-collection-trigger">
        <CollectableFacepile group={group} />
        <span className="collect-collection-body">
          <strong className="collect-collection-name" title={group.label}>
            {group.label}
          </strong>
          <span className="collect-collection-meta">{groupQuantityLabel(group)}</span>
        </span>
        <Accordion.ItemIndicator className="collect-collection-indicator" aria-hidden>
          ▾
        </Accordion.ItemIndicator>
      </Accordion.ItemTrigger>
      <Accordion.ItemContent value={group.key} className="collect-collection-body-content">
        <CollectableItems
          items={group.items}
          view={view}
          verification={verification}
          sendingOutpoint={sendingOutpoint}
        />
      </Accordion.ItemContent>
    </Accordion.Item>
  )
}

function FungibleCarouselCard({
  token,
  sending,
}: {
  token: FungibleToken
  sending: boolean
}) {
  const amount = formatFungibleAmount(token.amt, token.dec)
  const sendBlocked =
    !token.colourSupply ||
    token.spendKind === 'cosigned' ||
    token.spendKind === 'mixed'
  const isLegacy = !token.colourSupply
  const cap =
    token.colourSupply === 'locked' && token.colourMaxSupply != null
      ? formatFungibleAmount(String(token.colourMaxSupply), token.dec)
      : token.colourSupply
        ? '∞'
        : null
  const amountLabel = cap != null ? `${amount} / ${cap}` : amount
  const supplyBadge = isLegacy ? 'Legacy · burn only' : null
  return (
    <li
      className="collect-token-card"
      data-sending={sending ? 'true' : undefined}
      data-legacy={isLegacy ? 'true' : undefined}
    >
      <button
        type="button"
        className="collect-token-card-main"
        onClick={() => {
          playWalletSound('soft')
          openFungibleDetails(token.tokenId)
        }}
      >
        <FungibleTokenFace
          tokenId={token.tokenId}
          sym={token.sym}
          iconUrl={token.iconUrl}
          size={56}
        />
        <strong className="collect-token-card-sym">{token.sym}</strong>
        <span className="collect-token-card-id" title={token.tokenId}>
          {shortOriginLabel(token.tokenId)}
        </span>
        {token.issuer ? (
          <span
            className="collect-token-card-id"
            title={token.issuerHandle ? `${token.issuerHandle} · ${token.issuer}` : token.issuer}
          >
            {token.issuerHandle || shortIssuerLabel(token.issuer)}
          </span>
        ) : null}
        <span className="collect-token-card-amt">{amountLabel}</span>
        {supplyBadge ? (
          <span className="collect-token-card-meta">{supplyBadge}</span>
        ) : null}
      </button>
      {isLegacy ? (
        <button
          type="button"
          className="collectable-send-btn collectable-burn-btn"
          title={`Burn legacy BSV-21 ${token.sym}`}
          aria-label={`Burn ${token.sym}`}
          onClick={(e) => {
            e.stopPropagation()
            playWalletSound('soft')
            openBurnFungible(token.tokenId)
          }}
        >
          <FireIcon size={14} />
          Burn
        </button>
      ) : (
        <button
          type="button"
          className="collectable-send-btn"
          title={
            sendBlocked
              ? token.spendKind === 'cosigned'
                ? 'Cosigner required to send'
                : 'Mixed plain / cosigned tips'
              : sending
                ? `Sending ${token.sym}`
                : `Send ${token.sym}`
          }
          aria-label={
            sending ? `Sending ${token.sym}` : `Send ${token.sym}`
          }
          disabled={sending || sendBlocked}
          onClick={(e) => {
            e.stopPropagation()
            if (sendBlocked) return
            playWalletSound('soft')
            openSendFungible(token.tokenId)
          }}
        >
          <SendIcon size={14} />
          {sending ? 'Sending' : 'Send'}
        </button>
      )}
    </li>
  )
}

export function InventoryPanel() {
  const [view, setView] = useState<CollectionView>(() => getCollectionView('collectables'))
  const [items, setItems] = useState<Collectable[]>(() => getCachedCollectables())
  const [tokens, setTokens] = useState<FungibleToken[]>(() => getCachedFungibles())
  /** Only true after a successful listOutputs (may be empty). */
  const [ready, setReady] = useState(() => areCollectablesHydrated())
  const [tokensReady, setTokensReady] = useState(() => areFungiblesHydrated())
  /** In-flight load while we still have nothing to show. */
  const [awaitingFirst, setAwaitingFirst] = useState(
    () => !areCollectablesHydrated() && getCachedCollectables().length === 0,
  )
  const [verification, setVerification] = useState<VerificationProgress>(() =>
    getVerificationProgress(),
  )
  const [sendingOutpoint, setSendingOutpoint] = useState<string | null>(() =>
    getPaymentProgress().phase === 'idle' ? null : getPaymentProgress().outpoint,
  )

  useEffect(() => subscribeCollectionView(setView, 'collectables'), [])
  useEffect(() => subscribeVerificationProgress(setVerification), [])
  useEffect(
    () =>
      subscribePaymentProgress((next) => {
        setSendingOutpoint(next.phase === 'idle' ? null : next.outpoint)
      }),
    [],
  )
  useEffect(
    () =>
      subscribeCollectables((next) => {
        setItems(next)
        if (areCollectablesHydrated()) {
          setReady(true)
          setAwaitingFirst(false)
        }
      }),
    [],
  )
  useEffect(
    () =>
      subscribeFungibles((next) => {
        setTokens(next)
        if (areFungiblesHydrated()) setTokensReady(true)
      }),
    [],
  )
  useEffect(() => {
    const cached = getCachedCollectables().length
    console.info(`[collectables] open cache=${cached} hydrated=${areCollectablesHydrated()}`)
  }, [])

  useEffect(() => {
    let cancelled = false

    const refresh = async (reason: string) => {
      const showSpinner = !areCollectablesHydrated() && getCachedCollectables().length === 0
      if (showSpinner && !cancelled) setAwaitingFirst(true)
      try {
        console.info(`[collectables] listOutputs start (${reason})`)
        const started = performance.now()
        await Promise.all([listCollectables(), listFungibles()])
        console.info(
          `[collectables] listOutputs done (${reason}) ${Math.round(performance.now() - started)}ms`,
        )
        if (!cancelled) {
          setReady(areCollectablesHydrated())
          setTokensReady(areFungiblesHydrated())
          setAwaitingFirst(false)
        }
      } catch (err) {
        console.warn('[collectables] refresh failed', err)
        if (!cancelled && areCollectablesHydrated()) {
          setReady(true)
          setAwaitingFirst(false)
        }
      }
    }

    // CRITICAL: paint from durable cache immediately, then reconcile against
    // live address UTXOs within a beat. Waiting 15s left spent tips on screen.
    // Network work is async — it must not block the first paint.
    const hasCache =
      getCachedCollectables().length > 0 ||
      areCollectablesHydrated() ||
      getCachedFungibles().length > 0 ||
      areFungiblesHydrated()
    let intervalId = 0
    let deferTimer = 0

    if (hasCache) {
      deferTimer = window.setTimeout(() => {
        if (cancelled) return
        void refresh('ownership')
        intervalId = window.setInterval(() => {
          void refresh('interval')
        }, 5 * 60_000)
      }, 750)
      return () => {
        cancelled = true
        window.clearTimeout(deferTimer)
        if (intervalId) window.clearInterval(intervalId)
      }
    }

    // Cold start only — nothing to show until the basket is read once.
    deferTimer = window.setTimeout(() => {
      if (!cancelled) void refresh('cold')
    }, 2_500)
    intervalId = window.setInterval(() => {
      void refresh('interval')
    }, 5 * 60_000)
    return () => {
      cancelled = true
      window.clearTimeout(deferTimer)
      if (intervalId) window.clearInterval(intervalId)
    }
  }, [])

  const showLoading = (awaitingFirst || !ready) && items.length === 0 && tokens.length === 0
  const { groups, loose } = useMemo(() => groupCollectables(items), [items])
  const empty = items.length === 0 && tokens.length === 0 && ready && tokensReady

  return (
    <div
      className="nav-section-body"
      data-aeon-scope="collectables"
      data-aeon-state={view}
    >
      <div className="connected-panel-head">
        <h2>Collectables</h2>
        <CollectionViewToggle label="Collectables view" scope="collectables" />
      </div>

      {tokens.length > 0 ? (
        <section className="collect-tokens-section" aria-label="Tokens">
          <h3 className="collect-section-title">Tokens</h3>
          <ul
            className="collect-token-carousel"
            role="list"
            aria-label="Token carousel"
          >
            {tokens.map((token) => (
              <FungibleCarouselCard
                key={token.tokenId}
                token={token}
                sending={
                  sendingOutpoint != null && isOutpointSending(token.outpoint)
                }
              />
            ))}
          </ul>
        </section>
      ) : null}

      {items.length > 0 ? (
        <section className="collect-items-section" aria-label="Items">
          {tokens.length > 0 ? <h3 className="collect-section-title">Items</h3> : null}

          {groups.length > 0 ? (
            <Accordion.Root collapsible className="collect-collections">
              {groups.map((group) => (
                <CollectionGroupItem
                  key={group.key}
                  group={group}
                  view={view}
                  verification={verification}
                  sendingOutpoint={sendingOutpoint}
                />
              ))}
            </Accordion.Root>
          ) : null}

          {loose.length > 0 ? (
            <>
              {groups.length > 0 ? (
                <h3 className="collect-section-title">Not in a collection</h3>
              ) : null}
              <CollectableItems
                items={loose}
                view={view}
                verification={verification}
                sendingOutpoint={sendingOutpoint}
              />
            </>
          ) : null}

          {getCollectablePageStatus().hasMore ? (
            <div className="actions collect-load-more">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void loadMoreCollectables()}
              >
                Load older items
              </button>
              <span className="settings-row-desc">
                {getCollectablePageStatus().loadedOutputs.toLocaleString()} of{' '}
                {getCollectablePageStatus().totalOutputs.toLocaleString()} wallet outputs checked
              </span>
            </div>
          ) : null}
        </section>
      ) : null}

      {showLoading ? (
        <EmptyState
          icon={<CollectablesIcon size={28} />}
          title="Looking for collectables…"
          body="Checking this device for one-sat items and tokens."
        />
      ) : empty ? (
        <EmptyState
          icon={<CollectablesIcon size={28} />}
          title="No collectables here"
          body="Items and tokens live on the install that received them. This device updates from the network automatically; send to move them."
        />
      ) : null}
    </div>
  )
}
