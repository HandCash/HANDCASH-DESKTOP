import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  currentIssuerResolver,
  currentIssuerTrust,
  useIssuerIdentitiesGeneration,
} from '../hooks/useIssuerView'
import { Accordion } from '@aeon-ui/react'
import { CollectionViewToggle } from './CollectionViewToggle'
import { DeferredImage } from './DeferredImage'
import { BapFingerprint } from './BapIdenticon'
import { IssuerTrustBadge, issuerTrustNote, issuerViewState } from './IssuerIdentityMark'
import { CollectableVerifyMark } from './CollectableVerifyMark'
import { CollectableSendingMark, CollectableListedMark } from './CollectableSendingMark'
import { useChunkedCount } from './useChunkedCount'
import { useScrollIdle } from './uiFeed/useScrollIdle'
import { useWindowedRange } from './uiFeed/useWindowedRange'
import {
  getCollectionView,
  subscribeCollectionView,
  type CollectionView,
} from '../wallet/collectionView'
import {
  areCollectablesHydrated,
  getCollectablePageStatus,
  getCachedCollectables,
  getCollectablesLastListedAt,
  listCollectables,
  loadMoreCollectables,
  subscribeCollectables,
  collectableIsFungible,
  type Collectable,
} from '../features/collectables'
import { searchCollectables } from '../wallet/collectableSearch'
import { subscribeAppActivity } from '../features/activity'
import {
  groupCollectables,
  groupQuantityLabel,
  type CollectableGroup,
  type CollectableIssuer,
} from '../wallet/collectableGroups'
import {
  getVerificationProgress,
  isOutpointVerifying,
  subscribeVerificationProgress,
  type VerificationProgress,
} from '../wallet/verificationProgress'
import {
  inFlightVerb,
  isOutpointSending,
  subscribePaymentProgress,
} from '../wallet/paymentProgress'
import {
  openBurnCollectables,
  openCollectableDetails,
  openFungibleDetails,
  openSendCollectable,
  openSendCollectables,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { EmptyState } from './EmptyState'
import { FungibleTokenFace } from './FungibleTokenFace'
import { CloseIcon, CollectablesIcon, FireIcon, SendIcon } from './icons'
import {
  areFungiblesHydrated,
  classifyFungibleEncoding,
  formatFungibleAmount,
  getCachedFungibles,
  listFungibles,
  subscribeFungibles,
  type FungibleToken,
  shortIssuerLabel,
} from '../wallet/token'
import {
  formatPrimaryFromSats,
  getCachedUsdPerBsv,
} from '../wallet/fx'
import { getDisplayCurrency } from '../wallet/displayCurrency'
import {
  getMarketListingAuthorization,
  marketListingMark,
  type MarketListingMark,
} from '../features/market'
import { isItemSent } from '../wallet/sentItemGuard'
import {
  collectableSendReadyMessage,
  inspectCollectableSendReady,
} from '../wallet/collectableSendReady'
import {
  collectableBurnBatchRefusal,
  MAX_ITEMS_PER_COLLECTABLE_SEND_RUN,
  MAX_ITEMS_PER_ONE_SAT_TX,
} from '../wallet/collectableBatch'
import {
  reconcileCollectableSelection,
  selectableCollectables,
  selectionState,
  toggleCollectableSelection,
} from '../wallet/collectableSelection'
import { useWalletActionDock } from './WalletActionDock'

/** Paint a few cards per frame so opening Collect does not block the UI. */
const RENDER_CHUNK = 6
/** A basket answer this recent is reused on a tab visit instead of re-read. */
const INVENTORY_VISIT_FRESH_MS = 30_000

function SelectionCheckbox({
  checked,
  mixed = false,
  disabled = false,
  label,
  onChange,
  className = '',
}: {
  checked: boolean
  mixed?: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
  className?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed
  }, [mixed])
  return (
    <label
      className={`collect-select ${className}`.trim()}
      title={label}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden />
    </label>
  )
}

function liveMarketListing(outpoint: string): MarketListingMark | null {
  // Spent tips can still have a local listing auth until the next write;
  // never show Listed on something we already hid as sent.
  if (isItemSent(outpoint)) return null
  return marketListingMark(getMarketListingAuthorization({ outpoint }))
}

function listedMarkLabel(mark: MarketListingMark): string {
  const price = formatPrimaryFromSats(mark.priceSats, getDisplayCurrency(), getCachedUsdPerBsv())
  return mark.kind === 'unpublished' ? `Not published · ${price}` : `Listed · ${price}`
}

function collectableSendUi(
  item: Collectable,
  verifying: boolean,
  sending: boolean,
): { disabled: boolean; title: string } {
  const ready = inspectCollectableSendReady({
    outpoint: item.outpoint,
    proven: item.proven,
    verifying,
  })
  if (!ready.ready) {
    return {
      disabled: true,
      title: collectableSendReadyMessage(ready.reason),
    }
  }
  const verb = inFlightVerb(item.outpoint) ?? 'Sending'
  return {
    disabled: sending,
    title: sending ? `${verb} ${item.name}` : `Send ${item.name}`,
  }
}

function CollectableGridItem({
  item,
  verifying,
  sending,
  selected,
  onSelectedChange,
}: {
  item: Collectable
  verifying: boolean
  sending: boolean
  selected: boolean
  onSelectedChange: (checked: boolean) => void
}) {
  const verb = inFlightVerb(item.outpoint) ?? 'Sending'
  const listing = liveMarketListing(item.outpoint)
  const sendUi = collectableSendUi(item, verifying, sending)
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
          <CollectableSendingMark sending={sending} verb={verb} />
          {listing ? (
            <CollectableListedMark mark={listing.kind} label={listedMarkLabel(listing)} />
          ) : null}
          <CollectableVerifyMark verifying={verifying} outpoint={item.outpoint} />
        </div>
        <strong className="collection-grid-name" title={item.name}>
          {item.name}
        </strong>
        <span
          className="collection-grid-host"
          title={item.app}
          aria-hidden={item.app ? undefined : true}
        >
          {item.app || '\u00a0'}
        </span>
      </button>
      <div className="collectable-card-actions">
        <button
          type="button"
          className="collectable-send-btn"
          title={sendUi.title}
          aria-label={sendUi.title}
          disabled={sendUi.disabled}
          onClick={(e) => {
            e.stopPropagation()
            if (sendUi.disabled) return
            playWalletSound('soft')
            openSendCollectable(item.outpoint)
          }}
        >
          <SendIcon size={14} />
          {sending ? verb : 'Send'}
        </button>
        <SelectionCheckbox
          className="collect-select--inline"
          checked={selected}
          disabled={sending}
          label={`${selected ? 'Deselect' : 'Select'} ${item.name}`}
          onChange={onSelectedChange}
        />
      </div>
    </li>
  )
}

function CollectableListItem({
  item,
  verifying,
  sending,
  selected,
  onSelectedChange,
}: {
  item: Collectable
  verifying: boolean
  sending: boolean
  selected: boolean
  onSelectedChange: (checked: boolean) => void
}) {
  const verb = inFlightVerb(item.outpoint) ?? 'Sending'
  const listing = liveMarketListing(item.outpoint)
  const sendUi = collectableSendUi(item, verifying, sending)
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
          <CollectableSendingMark sending={sending} verb={verb} />
          {listing ? (
            <CollectableListedMark mark={listing.kind} label={listedMarkLabel(listing)} />
          ) : null}
          <CollectableVerifyMark verifying={verifying} outpoint={item.outpoint} />
        </div>
        <div className="connected-app-body">
          <strong className="connected-app-name">{item.name}</strong>
          <span
            className="connected-app-host"
            aria-hidden={item.app ? undefined : true}
          >
            {item.app || '\u00a0'}
          </span>
        </div>
      </button>
      <div className="collectable-row-actions">
        <button
          type="button"
          className="collectable-send-btn collectable-send-btn--row"
          title={sendUi.title}
          aria-label={sendUi.title}
          disabled={sendUi.disabled}
          onClick={() => {
            if (sendUi.disabled) return
            playWalletSound('soft')
            openSendCollectable(item.outpoint)
          }}
        >
          <SendIcon size={14} />
        </button>
        <SelectionCheckbox
          className="collect-select--row"
          checked={selected}
          disabled={sending}
          label={`${selected ? 'Deselect' : 'Select'} ${item.name}`}
          onChange={onSelectedChange}
        />
      </div>
    </li>
  )
}


/** Grid or list of individual items — used loose and inside a collection. */
function CollectableItems({
  items,
  view,
  verification,
  selected,
  onSelectionChange,
  columns = 3,
}: {
  items: Collectable[]
  view: CollectionView
  verification: VerificationProgress
  selected: ReadonlySet<string>
  onSelectionChange: (items: readonly Collectable[], checked: boolean) => void
  /** Grid columns the CSS lays out at this nesting — folders are fixed at two. */
  columns?: number
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const scrolling = useScrollIdle(listRef)
  const shownCount = useChunkedCount(items.length, RENDER_CHUNK, scrolling)
  const windowed = useWindowedRange({
    total: shownCount,
    itemExtent: view === 'grid' ? 176 : 56,
    columns: view === 'grid' ? columns : 1,
    overscan: 6,
    scrollRef: listRef,
  })
  const visible = items.slice(windowed.start, windowed.end)
  const Item = view === 'grid' ? CollectableGridItem : CollectableListItem

  return (
    <ul
      className={view === 'grid' ? 'collection-grid' : 'connected-app-list'}
      ref={listRef}
      style={
        windowed.padStart > 0 || windowed.padEnd > 0
          ? { paddingTop: windowed.padStart, paddingBottom: windowed.padEnd }
          : undefined
      }
    >
      {visible.map((item) => (
        <Item
          key={item.outpoint}
          item={item}
          verifying={isOutpointVerifying(item.outpoint, verification)}
          sending={isOutpointSending(item.outpoint)}
          selected={selected.has(item.outpoint)}
          onSelectedChange={(checked) => onSelectionChange([item], checked)}
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

function IssuerGroupItem({
  issuer,
  view,
  verification,
  selected,
  onSelectionChange,
}: {
  issuer: CollectableIssuer
  view: CollectionView
  verification: VerificationProgress
  selected: ReadonlySet<string>
  onSelectionChange: (items: readonly Collectable[], checked: boolean) => void
}) {
  const sendingHere = issuer.items.some((item) => isOutpointSending(item.outpoint))
  const available = issuer.items.filter((item) => !isOutpointSending(item.outpoint))
  const state = selectionState(selected, available)
  const selectedCount = issuer.items.filter((item) => selected.has(item.outpoint)).length
  const faceGroup: CollectableGroup = {
    key: issuer.key,
    app: issuer.app,
    label: issuer.label,
    items: issuer.items,
    faces: issuer.faces,
    overflow: issuer.overflow,
    quantity: issuer.quantity,
    provenCount: issuer.provenCount,
  }

  return (
    <Accordion.Item
      value={issuer.key}
      className="collect-collection"
      data-sending={sendingHere ? 'true' : undefined}
      data-selected={state === 'none' ? undefined : state}
    >
      <div className="collect-collection-head">
        <Accordion.ItemTrigger value={issuer.key} className="collect-collection-trigger">
          {issuer.icon ? (
            <DeferredImage
              className="collect-issuer-icon"
              src={issuer.icon}
              alt=""
              width={40}
              height={40}
              fallback={<CollectableFacepile group={faceGroup} />}
            />
          ) : (
            <CollectableFacepile group={faceGroup} />
          )}
          <span className="collect-collection-body">
            <strong
              className="collect-collection-name"
              data-aeon-state={issuer.bap ? issuerViewState(issuer) : undefined}
              title={
                issuer.bap
                  ? `${issuer.bap.state === 'verified' ? `${issuer.label} · ` : ''}BAP ID ${issuer.bap.id} · ${issuerTrustNote(issuer)}`
                  : issuer.identityKey
                    ? `${issuer.label} · issuer attribution: ${issuer.identityKey}`
                    : issuer.label
              }
            >
              <span className="collect-collection-name-text">{issuer.label}</span>
              {issuer.bap ? <IssuerTrustBadge view={issuer} /> : null}
            </strong>
            <span className="collect-collection-meta">
              {issuer.bap ? (
                <BapFingerprint
                  bapId={issuer.bap.id}
                  className="collect-issuer-fingerprint"
                  showId={issuer.bap.state === 'verified'}
                />
              ) : null}
              {groupQuantityLabel(issuer)}
              {selectedCount > 0 ? ` · ${selectedCount} selected` : ''}
            </span>
          </span>
          <Accordion.ItemIndicator className="collect-collection-indicator" aria-hidden>
            ▾
          </Accordion.ItemIndicator>
        </Accordion.ItemTrigger>
        <SelectionCheckbox
          className="collect-select--group"
          checked={state === 'all'}
          mixed={state === 'some'}
          disabled={available.length === 0}
          label={`${state === 'all' ? 'Deselect' : 'Select'} ${issuer.label}`}
          onChange={(checked) => onSelectionChange(available, checked)}
        />
      </div>
      <Accordion.ItemContent value={issuer.key} className="collect-collection-body-content">
        {issuer.tokens.length > 0 ? (
          <section className="collect-nested-collection" data-aeon-part="issuer-tokens">
            {issuer.items.length > 0 ? (
              <h4 className="collect-section-title collect-nested-title">Tokens</h4>
            ) : null}
            <TokenShelf
              tokens={issuer.tokens}
              view={view}
              label={`${issuer.label} tokens`}
              issuerLabel={issuer.bapId ? issuer.label : undefined}
            />
          </section>
        ) : null}
        {issuer.collections.map((collection) => (
          <section key={collection.key} className="collect-nested-collection">
            <h4 className="collect-section-title collect-nested-title">{collection.label}</h4>
            <CollectableItems
              items={collection.items}
              view={view}
              verification={verification}
              selected={selected}
              onSelectionChange={onSelectionChange}
              columns={2}
            />
          </section>
        ))}
        {issuer.loose.length > 0 ? (
          <section className="collect-nested-collection">
            {issuer.collections.length > 0 || issuer.tokens.length > 0 ? (
              <h4 className="collect-section-title collect-nested-title">
                {issuer.collections.length > 0 ? 'Uncollected' : 'Items'}
              </h4>
            ) : null}
            <CollectableItems
              items={issuer.loose}
              view={view}
              verification={verification}
              selected={selected}
              onSelectionChange={onSelectionChange}
              columns={2}
            />
          </section>
        ) : null}
      </Accordion.ItemContent>
    </Accordion.Item>
  )
}

/**
 * One token in the strip: a circle face with the symbol and balance under it.
 * Same chip in both collection views — the strip is a row carousel; grid view
 * only grows the face. Send / Burn live in the details face the chip opens.
 */
function FungibleItem({
  token,
  sending,
  view,
  issuerLabel,
}: {
  token: FungibleToken
  sending: boolean
  view: CollectionView
  /** The BAP shelf's label; a cached handle never overrides it. */
  issuerLabel?: string
}) {
  const amount = formatFungibleAmount(token.amt, token.dec)
  const encoding = classifyFungibleEncoding(token)
  const issuer = issuerLabel
    ? issuerLabel
    : token.issuer
    ? token.issuerHandle || shortIssuerLabel(token.issuer)
    : encoding.kind === 'legacy-json'
      ? 'Legacy BSV-21'
      : 'BSV-21'
  const listing: MarketListingMark | null = token.marketListing
    ? token.marketListing.published === false
      ? { kind: 'unpublished', priceSats: token.marketListing.priceSats, reason: '' }
      : { kind: 'listed', priceSats: token.marketListing.priceSats }
    : liveMarketListing(token.outpoint)
  const verb = inFlightVerb(token.outpoint) ?? 'Sending'
  const face = view === 'grid' ? 72 : 56
  const state = sending ? 'sending' : listing ? listing.kind : 'idle'
  const openDetails = () => {
    playWalletSound('soft')
    openFungibleDetails(token.tokenId)
  }

  return (
    <li className="token-chip" data-aeon-part="token" data-aeon-state={state}>
      <button
        type="button"
        className="token-chip-main"
        onClick={openDetails}
        title={`${token.sym} · ${issuer}`}
        aria-label={`${token.sym}, ${amount}, ${issuer}`}
      >
        <span className="collectable-media collectable-media-sm collectable-media-token token-chip-face">
          <FungibleTokenFace
            tokenId={token.tokenId}
            sym={token.sym}
            iconUrl={token.iconUrl}
            size={face}
            shape="circle"
          />
          <CollectableSendingMark sending={sending} verb={verb} />
          {listing ? (
            <CollectableListedMark mark={listing.kind} label={listedMarkLabel(listing)} />
          ) : null}
        </span>
        <strong className="token-chip-sym" title={token.sym}>
          {token.sym}
        </strong>
        <span className="fungible-card-amount token-chip-amount" title={amount}>
          {amount}
        </span>
      </button>
    </li>
  )
}

/** Horizontal row carousel of token circles — the same shelf loose and inside an issuer. */
function TokenShelf({
  tokens,
  view,
  label,
  issuerLabel,
}: {
  tokens: readonly FungibleToken[]
  view: CollectionView
  label: string
  issuerLabel?: string
}) {
  return (
    <ul
      className="token-strip"
      role="list"
      aria-label={label}
      data-aeon-part="token-strip"
      data-aeon-state={view}
    >
      {tokens.map((token) => (
        <FungibleItem
          key={token.tokenId}
          token={token}
          sending={isOutpointSending(token.outpoint)}
          view={view}
          issuerLabel={issuerLabel}
        />
      ))}
    </ul>
  )
}

export function InventoryPanel() {
  const identityGeneration = useIssuerIdentitiesGeneration()
  const [view, setView] = useState<CollectionView>(() => getCollectionView('collectables'))
  const [items, setItems] = useState<Collectable[]>(() => getCachedCollectables())
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [tokens, setTokens] = useState<FungibleToken[]>(() => getCachedFungibles())
  const [query, setQuery] = useState('')
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
  const [, bumpInFlight] = useState(0)

  useEffect(() => subscribeCollectionView(setView, 'collectables'), [])
  useEffect(() => subscribeVerificationProgress(setVerification), [])
  useEffect(
    () =>
      subscribePaymentProgress(() => {
        bumpInFlight((n) => n + 1)
      }),
    [],
  )
  useEffect(
    () =>
      subscribeAppActivity(() => {
        // Background ingest can update several Activity rows in one pass.
        // Inventory still needs the eventual in-flight verb, but it must not
        // preempt a tap, scroll, or search keystroke with a full card-tree render.
        startTransition(() => bumpInFlight((n) => n + 1))
      }),
    [],
  )
  useEffect(
    () =>
      subscribeCollectables((next) => {
        // The durable snapshot already supplied first paint. Background
        // identity/authenticity upgrades are non-urgent and must yield to input.
        startTransition(() => {
          setItems(next)
          if (areCollectablesHydrated()) {
            setReady(true)
            setAwaitingFirst(false)
          }
        })
      }),
    [],
  )
  useEffect(
    () =>
      subscribeFungibles((next) => {
        startTransition(() => {
          setTokens(next)
          if (areFungiblesHydrated()) setTokensReady(true)
        })
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
      const { getSpendPriorityDepth, shouldYieldChainIngestToSpend } =
        await import('../wallet/walletCoordinator')
      if (shouldYieldChainIngestToSpend() || getSpendPriorityDepth() > 0) {
        console.info(`[collectables] deferring refresh (${reason}) — send waiting`)
        return
      }
      // Flipping back to this tab seconds after the basket answered is not new
      // information; ingest, sends and receives already relist on their own.
      const sinceListed = Date.now() - getCollectablesLastListedAt()
      if (reason === 'ownership' && sinceListed < INVENTORY_VISIT_FRESH_MS) {
        console.info(
          `[collectables] basket read ${Math.round(sinceListed / 1000)}s ago — not re-reading on visit`,
        )
        setReady(areCollectablesHydrated())
        setTokensReady(areFungiblesHydrated())
        setAwaitingFirst(false)
        return
      }
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
      const cachedCount = getCachedCollectables().length
      const delayMs = cachedCount > 100 ? 8_000 : 750
      deferTimer = window.setTimeout(() => {
        if (cancelled) return
        void refresh('ownership')
        intervalId = window.setInterval(() => {
          void refresh('interval')
        }, 5 * 60_000)
      }, delayMs)
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

  const deferredItems = useDeferredValue(items)
  const deferredQuery = useDeferredValue(query)
  // `tokens` is a dependency on purpose: a one-sat tip is an NFT until the
  // fungibles cache hydrates and claims it, so the split must re-run then.
  const visibleItems = useMemo(() => {
    const nfts = deferredItems.filter((item) => !collectableIsFungible(item))
    return searchCollectables(deferredQuery, nfts)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tokens drive collectableIsFungible via its cache
  }, [deferredItems, deferredQuery, tokens])
  const busyOutpoints = useMemo(
    () =>
      new Set(
        visibleItems
          .filter((item) => isOutpointSending(item.outpoint))
          .map((item) => item.outpoint),
      ),
    [visibleItems],
  )
  const availableItems = useMemo(
    () => selectableCollectables(visibleItems, busyOutpoints),
    [visibleItems, busyOutpoints],
  )
  const selectedItems = useMemo(
    () => availableItems.filter((item) => selected.has(item.outpoint)),
    [availableItems, selected],
  )
  const selectedCount = selectedItems.length
  const selectionChange = (target: readonly Collectable[], checked: boolean) => {
    setSelected((current) => toggleCollectableSelection(current, target, checked))
  }

  useEffect(() => {
    setSelected((current) => reconcileCollectableSelection(current, availableItems))
  }, [availableItems])

  const selectedCanSend =
    selectedCount > 0 &&
    selectedCount <= MAX_ITEMS_PER_COLLECTABLE_SEND_RUN &&
    selectedItems.every((item) =>
      inspectCollectableSendReady({
        outpoint: item.outpoint,
        proven: item.proven,
        verifying: isOutpointVerifying(item.outpoint, verification),
      }).ready,
    )
  /** Burn is a single atomic transaction — it has no leg loop to fall back on. */
  const overBurnCeiling = selectedCount > MAX_ITEMS_PER_ONE_SAT_TX
  const selectedCanBurn =
    selectedCount > 0 &&
    !overBurnCeiling &&
    selectedItems.every((item) => !item.covenantLocked)

  useWalletActionDock(
    selectedCount > 0
      ? {
          ariaLabel: `${selectedCount} selected collectables`,
          tertiary: {
            label: 'Cancel',
            onClick: () => setSelected(new Set()),
            icon: <CloseIcon size={18} />,
            tone: 'danger',
          },
          secondary: {
            label: `Burn (${selectedCount})`,
            shortLabel: `Burn (${selectedCount})`,
            onClick: () =>
              openBurnCollectables(selectedItems.map((item) => item.outpoint)),
            disabled: !selectedCanBurn,
            tone: 'danger',
            icon: <FireIcon size={18} />,
            title: selectedCanBurn
              ? `Burn ${selectedCount} collectables`
              : (collectableBurnBatchRefusal(selectedCount) ??
                'A selected item cannot be burned'),
          },
          primary: {
            label: `Send (${selectedCount})`,
            shortLabel: `Send (${selectedCount})`,
            onClick: () =>
              openSendCollectables(selectedItems.map((item) => item.outpoint)),
            disabled: !selectedCanSend,
            tone: 'primary',
            icon: <SendIcon size={18} />,
            title: selectedCanSend
              ? `Send ${selectedCount} collectables`
              : selectedCount > MAX_ITEMS_PER_COLLECTABLE_SEND_RUN
                ? `Send up to ${MAX_ITEMS_PER_COLLECTABLE_SEND_RUN} collectables at a time`
                : 'Wait for selected items to finish verification',
          },
        }
      : null,
  )
  const showLoading = (awaitingFirst || !ready) && visibleItems.length === 0 && tokens.length === 0
  const searching = deferredQuery.trim().length > 0
  const { issuers, ungrouped, ungroupedTokens } = useMemo(
    () =>
      groupCollectables(
        visibleItems,
        searching ? [] : tokens,
        currentIssuerResolver(),
        currentIssuerTrust(),
      ),
    [visibleItems, tokens, searching, identityGeneration],
  )
  const empty =
    items.filter((item) => !collectableIsFungible(item)).length === 0 &&
    tokens.length === 0 &&
    ready &&
    tokensReady
  const searchEmpty = !empty && !showLoading && visibleItems.length === 0 && searching

  return (
    <div
      className="nav-section-body nav-section-with-scroll"
      data-aeon-scope="collectables"
      data-aeon-state={view}
    >
      <div className="connected-panel-head">
        <h2>Collectables</h2>
        <CollectionViewToggle label="Collectables view" scope="collectables" />
      </div>
      {empty && !showLoading ? (
        <EmptyState
          icon={<CollectablesIcon size={28} />}
          title="No collectables here"
          body="Items and tokens live on the install that received them. This device updates from the network automatically; send to move them."
        />
      ) : (
        <div className="nav-section-scroll-body">
          <div className="root-search friends-search" role="search">
            <label className="sr-only" htmlFor="collectables-search-input">
              Search collectables
            </label>
            <input
              id="collectables-search-input"
              type="search"
              placeholder="Search name, traits, id — comma for multiple"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
            />
          </div>
          {searchEmpty ? (
            <div className="friends-empty">
              <strong>No collectables found</strong>
              <span>Try another name, trait, origin, or id.</span>
            </div>
          ) : null}
      {ungroupedTokens.length > 0 ? (
        <section className="collect-tokens-section" aria-label="Tokens">
          <h3 className="collect-section-title">Tokens</h3>
          <TokenShelf tokens={ungroupedTokens} view={view} label="Tokens without an issuer" />
        </section>
      ) : null}

      {visibleItems.length > 0 || issuers.length > 0 ? (
        <section className="collect-items-section" aria-label="Issuers and items">
          {ungroupedTokens.length > 0 ? (
            <h3 className="collect-section-title">Issuers</h3>
          ) : null}

          {issuers.length > 0 ? (
            <Accordion.Root
              collapsible
              className={
                issuers.length > 1
                  ? 'collect-collections collect-collections--many'
                  : 'collect-collections'
              }
            >
              {issuers.map((issuer) => (
                <IssuerGroupItem
                  key={issuer.key}
                  issuer={issuer}
                  view={view}
                  verification={verification}
                  selected={selected}
                  onSelectionChange={selectionChange}
                />
              ))}
            </Accordion.Root>
          ) : null}

          {ungrouped.length > 0 ? (
            <>
              {issuers.length > 0 ? (
                <h3 className="collect-section-title">No issuer</h3>
              ) : null}
              <CollectableItems
                items={ungrouped}
                view={view}
                verification={verification}
                selected={selected}
                onSelectionChange={selectionChange}
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
      ) : null}
        </div>
      )}
    </div>
  )
}
