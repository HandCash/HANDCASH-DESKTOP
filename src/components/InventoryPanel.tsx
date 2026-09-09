import { useEffect, useMemo, useRef, useState, useDeferredValue } from 'react'
import { Accordion } from '@aeon-ui/react'
import { CollectionViewToggle } from './CollectionViewToggle'
import { DeferredImage } from './DeferredImage'
import { CollectableVerifyMark } from './CollectableVerifyMark'
import { CollectableSendingMark, CollectableListedMark } from './CollectableSendingMark'
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
  collectableIsOnesatFt,
  type Collectable,
} from '../wallet/collectables'
import { searchCollectables } from '../wallet/collectableSearch'
import { subscribeAppActivity } from '../wallet/appActivity'
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
  inFlightVerb,
  isOutpointSending,
  subscribePaymentProgress,
} from '../wallet/paymentProgress'
import {
  openBurnCollectables,
  openBurnFungible,
  openCollectableDetails,
  openFungibleDetails,
  openSendCollectable,
  openSendCollectables,
  openSendFungible,
} from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { EmptyState } from './EmptyState'
import { FungibleTokenFace } from './FungibleTokenFace'
import { CloseIcon, CollectablesIcon, FireIcon, SendIcon } from './icons'
import {
  areFungiblesHydrated,
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
import { getMarketListingAuthorization } from '../wallet/marketListing'
import { isItemSent } from '../wallet/sentItemGuard'
import {
  collectableSendReadyMessage,
  inspectCollectableSendReady,
} from '../wallet/collectableSendReady'
import {
  reconcileCollectableSelection,
  selectableCollectables,
  selectionState,
  toggleCollectableSelection,
} from '../wallet/collectableSelection'
import { useWalletActionDock } from './WalletActionDock'

/** Paint a few cards per frame so opening Collect does not block the UI. */
const RENDER_CHUNK = 6

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

function liveMarketListingPrice(outpoint: string): number | null {
  // Spent tips can still have a local listing auth until the next write;
  // never show Listed on something we already hid as sent.
  if (isItemSent(outpoint)) return null
  const auth = getMarketListingAuthorization({ outpoint })
  if (!auth || (auth.state !== 'active' && auth.state !== 'reserved')) return null
  return auth.priceSats > 0 ? auth.priceSats : null
}

function listedMarkLabel(priceSats: number): string {
  const displayCurrency = getDisplayCurrency()
  const usdPerBsv = getCachedUsdPerBsv()
  return `Listed · ${formatPrimaryFromSats(priceSats, displayCurrency, usdPerBsv)}`
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
  const listPrice = liveMarketListingPrice(item.outpoint)
  const sendUi = collectableSendUi(item, verifying, sending)
  return (
    <li
      className="collection-grid-card collectable-card"
      data-sending={sending ? 'true' : undefined}
    >
      <SelectionCheckbox
        className="collect-select--card"
        checked={selected}
        disabled={sending}
        label={`${selected ? 'Deselect' : 'Select'} ${item.name}`}
        onChange={onSelectedChange}
      />
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
          {listPrice != null ? (
            <CollectableListedMark label={listedMarkLabel(listPrice)} />
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
  const listPrice = liveMarketListingPrice(item.outpoint)
  const sendUi = collectableSendUi(item, verifying, sending)
  return (
    <li
      className="connected-app-row collectable-row"
      data-sending={sending ? 'true' : undefined}
    >
      <SelectionCheckbox
        className="collect-select--row"
        checked={selected}
        disabled={sending}
        label={`${selected ? 'Deselect' : 'Select'} ${item.name}`}
        onChange={onSelectedChange}
      />
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
          {listPrice != null ? (
            <CollectableListedMark label={listedMarkLabel(listPrice)} />
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
        {sending ? verb : 'Send'}
      </button>
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
}: {
  items: Collectable[]
  view: CollectionView
  verification: VerificationProgress
  selected: ReadonlySet<string>
  onSelectionChange: (items: readonly Collectable[], checked: boolean) => void
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

function CollectionGroupItem({
  group,
  view,
  verification,
  selected,
  onSelectionChange,
}: {
  group: CollectableGroup
  view: CollectionView
  verification: VerificationProgress
  selected: ReadonlySet<string>
  onSelectionChange: (items: readonly Collectable[], checked: boolean) => void
}) {
  const sendingHere = group.items.some((item) => isOutpointSending(item.outpoint))
  const available = group.items.filter((item) => !isOutpointSending(item.outpoint))
  const state = selectionState(selected, available)
  const selectedCount = group.items.filter((item) => selected.has(item.outpoint)).length

  return (
    <Accordion.Item
      value={group.key}
      className="collect-collection"
      data-sending={sendingHere ? 'true' : undefined}
      data-selected={state === 'none' ? undefined : state}
    >
      <div className="collect-collection-head">
        <SelectionCheckbox
          className="collect-select--group"
          checked={state === 'all'}
          mixed={state === 'some'}
          disabled={available.length === 0}
          label={`${state === 'all' ? 'Deselect' : 'Select'} ${group.label}`}
          onChange={(checked) => onSelectionChange(available, checked)}
        />
        <Accordion.ItemTrigger value={group.key} className="collect-collection-trigger">
          <CollectableFacepile group={group} />
          <span className="collect-collection-body">
            <strong className="collect-collection-name" title={group.label}>
              {group.label}
            </strong>
            <span className="collect-collection-meta">
              {groupQuantityLabel(group)}
              {selectedCount > 0 ? ` · ${selectedCount} selected` : ''}
            </span>
          </span>
          <Accordion.ItemIndicator className="collect-collection-indicator" aria-hidden>
            ▾
          </Accordion.ItemIndicator>
        </Accordion.ItemTrigger>
      </div>
      <Accordion.ItemContent value={group.key} className="collect-collection-body-content">
        <CollectableItems
          items={group.items}
          view={view}
          verification={verification}
          selected={selected}
          onSelectionChange={onSelectionChange}
        />
      </Accordion.ItemContent>
    </Accordion.Item>
  )
}

function FungibleAction({
  token,
  sending,
  row = false,
}: {
  token: FungibleToken
  sending: boolean
  row?: boolean
}) {
  const sendBlocked =
    !token.colourSupply ||
    token.spendKind === 'cosigned' ||
    token.spendKind === 'mixed'
  const isLegacy = !token.colourSupply
  const verb = inFlightVerb(token.outpoint) ?? 'Sending'
  const burning = sending && /^burn/i.test(verb)
  const className = `collectable-send-btn${row ? ' collectable-send-btn--row' : ''}${
    isLegacy ? ' collectable-burn-btn' : ''
  }${burning ? ' is-burning' : ''}`
  const blockedTitle =
    token.spendKind === 'cosigned'
      ? 'Cosigner required to send'
      : 'Mixed plain / cosigned tips'

  return (
    <button
      type="button"
      className={className}
      title={
        isLegacy
          ? burning
            ? `${verb} ${token.sym}`
            : `Burn legacy BSV-21 ${token.sym}`
          : sendBlocked
            ? blockedTitle
            : sending
              ? `${verb} ${token.sym}`
              : `Send ${token.sym}`
      }
      aria-label={
        isLegacy
          ? burning
            ? `${verb} ${token.sym}`
            : `Burn ${token.sym}`
          : sending
            ? `${verb} ${token.sym}`
            : `Send ${token.sym}`
      }
      disabled={sending || (!isLegacy && sendBlocked)}
      aria-busy={burning || undefined}
      onClick={(event) => {
        event.stopPropagation()
        if (sending || (!isLegacy && sendBlocked)) return
        playWalletSound('soft')
        if (isLegacy) openBurnFungible(token.tokenId)
        else openSendFungible(token.tokenId)
      }}
    >
      {isLegacy ? <FireIcon size={14} /> : <SendIcon size={14} />}
      {burning ? 'Burning…' : sending ? verb : isLegacy ? 'Burn' : 'Send'}
    </button>
  )
}

function FungibleItem({
  token,
  sending,
  view,
}: {
  token: FungibleToken
  sending: boolean
  view: CollectionView
}) {
  const amount = formatFungibleAmount(token.amt, token.dec)
  const issuer = token.issuer
    ? token.issuerHandle || shortIssuerLabel(token.issuer)
    : !token.colourSupply
      ? 'Legacy BSV-21'
      : 'BSV-21'
  const listPrice =
    token.marketListing?.priceSats ??
    liveMarketListingPrice(token.outpoint)
  const verb = inFlightVerb(token.outpoint) ?? 'Sending'
  const openDetails = () => {
    playWalletSound('soft')
    openFungibleDetails(token.tokenId)
  }

  if (view === 'list') {
    return (
      <li
        className="connected-app-row collectable-row fungible-row"
        data-sending={sending ? 'true' : undefined}
      >
        <button
          type="button"
          className="connected-app-main collectable-row-main"
          onClick={openDetails}
        >
          <div className="collectable-media collectable-media-sm collectable-media-token">
            <FungibleTokenFace
              tokenId={token.tokenId}
              sym={token.sym}
              iconUrl={token.iconUrl}
              size={48}
            />
            <CollectableSendingMark sending={sending} verb={verb} />
            {listPrice != null ? (
              <CollectableListedMark label={listedMarkLabel(listPrice)} />
            ) : null}
          </div>
          <div className="connected-app-body">
            <strong className="connected-app-name">{token.sym}</strong>
            <span className="connected-app-host">{issuer}</span>
          </div>
          <strong className="fungible-card-amount">{amount}</strong>
        </button>
        <FungibleAction token={token} sending={sending} row />
      </li>
    )
  }

  return (
    <li
      className="collection-grid-card collectable-card fungible-card"
      data-sending={sending ? 'true' : undefined}
    >
      <button
        type="button"
        className="collection-grid-main collectable-main"
        onClick={openDetails}
      >
        <div className="collectable-media collectable-media-token">
          <FungibleTokenFace
            tokenId={token.tokenId}
            sym={token.sym}
            iconUrl={token.iconUrl}
            size={120}
          />
          <CollectableSendingMark sending={sending} verb={verb} />
          {listPrice != null ? (
            <CollectableListedMark label={listedMarkLabel(listPrice)} />
          ) : null}
        </div>
        <strong className="collection-grid-name" title={token.sym}>
          {token.sym}
        </strong>
        <span className="collection-grid-host" title={issuer}>
          {issuer}
        </span>
        <strong className="fungible-card-amount">{amount}</strong>
      </button>
      <FungibleAction token={token} sending={sending} />
    </li>
  )
}

export function InventoryPanel() {
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
  useEffect(() => subscribeAppActivity(() => bumpInFlight((n) => n + 1)), [])
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
      const { getSpendPriorityDepth, shouldYieldChainIngestToSpend } =
        await import('../wallet/walletCoordinator')
      if (shouldYieldChainIngestToSpend() || getSpendPriorityDepth() > 0) {
        console.info(`[collectables] deferring refresh (${reason}) — send waiting`)
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
  const visibleItems = useMemo(() => {
    const nfts = deferredItems.filter((item) => !collectableIsOnesatFt(item))
    return searchCollectables(deferredQuery, nfts)
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
    selectedItems.every((item) =>
      inspectCollectableSendReady({
        outpoint: item.outpoint,
        proven: item.proven,
        verifying: isOutpointVerifying(item.outpoint, verification),
      }).ready,
    )
  const selectedCanBurn =
    selectedCount > 0 && selectedItems.every((item) => !item.covenantLocked)

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
              : 'A selected item cannot be burned',
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
              : 'Wait for selected items to finish verification',
          },
        }
      : null,
  )
  const showLoading = (awaitingFirst || !ready) && visibleItems.length === 0 && tokens.length === 0
  const { groups, singles, ungrouped } = useMemo(() => groupCollectables(visibleItems), [visibleItems])
  const empty = items.filter((item) => !collectableIsOnesatFt(item)).length === 0 && tokens.length === 0 && ready && tokensReady
  const searchEmpty =
    !empty &&
    !showLoading &&
    visibleItems.length === 0 &&
    deferredQuery.trim().length > 0

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
          <div className="friends-search" role="search">
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
      {tokens.length > 0 && !deferredQuery.trim() ? (
        <section className="collect-tokens-section" aria-label="Tokens">
          <h3 className="collect-section-title">Tokens</h3>
          <ul
            className={view === 'grid' ? 'collection-grid' : 'connected-app-list'}
            role="list"
            aria-label="Tokens"
          >
            {tokens.map((token) => (
              <FungibleItem
                key={token.tokenId}
                token={token}
                sending={isOutpointSending(token.outpoint)}
                view={view}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {visibleItems.length > 0 ? (
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
                  selected={selected}
                  onSelectionChange={selectionChange}
                />
              ))}
            </Accordion.Root>
          ) : null}

          {singles.length > 0 ? (
            <>
              {groups.length > 0 ? (
                <h3 className="collect-section-title">Singles</h3>
              ) : null}
              <CollectableItems
                items={singles}
                view={view}
                verification={verification}
                selected={selected}
                onSelectionChange={selectionChange}
              />
            </>
          ) : null}

          {ungrouped.length > 0 ? (
            <>
              {groups.length > 0 || singles.length > 0 ? (
                <h3 className="collect-section-title">Not in a collection</h3>
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
