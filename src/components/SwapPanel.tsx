import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMachine } from '@xstate/react'
import { fromPromise } from 'xstate'
import { stateToAttr } from '@aeon-ui/core'
import { Button, ListRow, StatusBanner } from '@aeon-ui/react'
import { Switch } from '@aeon-ui/ui'
import { swapMachine } from '../machines/swapMachine'
import { useDirectSwaps, useSwapRecords, useHeldCoins } from '../features/swap'
import { useDisplayBalanceSats } from '../hooks/useDisplayBalanceSats'
import { getCachedBsvMarket, refreshBsvMarket } from '../wallet/bsvMarket'
import { openSwapOffers } from '../wallet/navStore'
import { playPaymentSuccessSound } from '../wallet/paymentSuccessSound'
import { playWalletSound } from '../wallet/soundService'
import { toastSuccess } from '../wallet/toast'
import { decimalToUnits, SWAP_ASSET_INFO, SWAP_ASSETS, unitsToDecimal, type SwapAsset } from '../wallet/swap/assets'
import { EXOLIX_FINAL, refreshSwapRecords, type SwapRecord } from '../wallet/swap/exolixSwap'
import { draftOfferAtMarket, type SwapOfferDraft } from '../wallet/swap/offerBook'
import { feeLegOf } from '../wallet/swap/fee'
import { MAKER_FUND_WITHIN_S, MAKER_LOCK_S, TAKER_LOCK_S } from '../wallet/swap/settle'
import { publishOwnSwapOffer } from '../wallet/swap/settleRunner'
import { fillOffer } from '../wallet/swap/offer'
import { listSwapOffers, quoteSwap, type SwapQuoteRefusal } from '../wallet/swap/quote'
import type { SwapRoute } from '../wallet/swap/routing'
import { runSwap, walletSwapPorts, type SwapStart } from '../wallet/swap/runSwap'
import type { Chain } from '../wallet/vault'
import { CoinSelect } from './NetworkPicker'
import { SwapIcon } from './icons'
import { SwapPairMark, SwapRouteBadge, SwapStatusPill, SwapSummary } from './SwapVisuals'

type Props = {
  /** This wallet's BSV payment address: where a swap into BSV pays out. */
  address: string
  identityKey: string
  chain: Chain
  onFail: (error: string) => void
}

const QUOTE_DEBOUNCE_MS = 500
const STATUS_POLL_MS = 30_000
const RECENT_SWAPS = 5

const fmt = (asset: SwapAsset, units: bigint) => `${unitsToDecimal(asset, units)} ${SWAP_ASSET_INFO[asset].ticker}`

function usdOf(asset: SwapAsset, units: bigint): number | null {
  const price = getCachedBsvMarket(asset)?.priceUsd
  return price ? (Number(units) / 1e8) * price : null
}

const usdText = (usd: number) => usd.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: usd < 1 ? 4 : 2 })

/** "1 LTC ≈ 3.24 BSV": both legs carry 8 decimals, so the unit ratio is the rate. */
function rateText(from: SwapAsset, to: SwapAsset, route: SwapRoute): string {
  const rate = Number(route.receive) / Number(route.pay)
  const digits = rate >= 100 ? 2 : rate >= 1 ? 4 : 8
  return `1 ${SWAP_ASSET_INFO[from].ticker} ≈ ${rate.toLocaleString(undefined, { maximumFractionDigits: digits })} ${SWAP_ASSET_INFO[to].ticker}`
}

function refusalText(refusal: SwapQuoteRefusal | { kind: 'failed'; detail: string }, from: SwapAsset): string {
  switch (refusal.kind) {
    case 'bad-request':
    case 'failed':
      return refusal.detail
    case 'no-route': {
      const e = refusal.exolix
      if (e?.kind === 'below-min') return `The smallest swap available is ${fmt(from, e.min)}.`
      if (e?.kind === 'above-max') return `The largest swap available is ${fmt(from, e.max)}.`
      return `No swap is available for this right now${e ? ` (${e.detail})` : ''}.`
    }
  }
}

const routeName = (route: SwapRoute) => (route.kind === 'exolix' ? 'Exolix' : `Direct · ${route.offer.maker.slice(0, 10)}…`)

function routeNote(route: SwapRoute): string {
  return route.kind === 'exolix'
    ? 'Exolix holds your coins between your deposit and its payout.'
    : 'Wallet to wallet: nobody holds your coins; both sides complete or both are refunded.'
}

function startedText(started: SwapStart): string {
  return started.via === 'exolix'
    ? `${fmt(started.record.from, BigInt(started.record.pay))} sent to Exolix; ${fmt(started.record.to, BigInt(started.record.receive))} pays out to this wallet.`
    : `Offer taken: this wallet locks ${fmt(started.from, started.pay)} once the maker accepts, then claims ${fmt(started.to, started.receive)} on its own.`
}

const hours = (seconds: number) => `${Math.round(seconds / 3600)} hours`

function recordText(record: SwapRecord): string {
  if (record.stage === 'created') return 'Opened, deposit not paid'
  if (record.stage === 'pay-failed') return `Deposit not paid${record.error ? ` — ${record.error}` : ''}`
  switch (record.status) {
    case 'wait':
      return 'Deposit sent, Exolix waiting for it'
    case 'confirmation':
    case 'confirmed':
      return 'Exolix confirming your deposit'
    case 'exchanging':
      return 'Exolix swapping'
    case 'sending':
      return 'Exolix paying out to this wallet'
    case 'success':
      return 'Paid out to this wallet'
    case 'overdue':
      return 'Expired at Exolix'
    case 'refunded':
      return 'Refunded to this wallet'
  }
}

/** The coin worth most in this wallet pays by default; into BSV, or out of BSV into BTC. */
function defaultPair(held: Record<SwapAsset, bigint>): { from: SwapAsset; to: SwapAsset } {
  const worth = (a: SwapAsset) => usdOf(a, held[a]) ?? (held[a] > 0n ? 0 : -1)
  const from = SWAP_ASSETS.reduce((best, a) => (worth(a) > worth(best) ? a : best), 'bsv' as SwapAsset)
  return { from, to: from === 'bsv' ? 'btc' : 'bsv' }
}

/**
 * Swap between coins this wallet holds, paid from and back to it, no addresses.
 * Two steps: choose coins and amount (the price follows as you type), then one
 * review that says who holds the coins; only Confirm there moves anything.
 * When no route can take it (under the smallest swap, say), the same amount
 * can be published as a standing offer at the market rate instead.
 */
export function SwapPanel({ address, identityKey, chain, onFail }: Props) {
  const bsvSats = useDisplayBalanceSats({ identityKey, chain })
  const coins = useHeldCoins()
  const held: Record<SwapAsset, bigint> = { bsv: BigInt(Math.max(0, Math.floor(bsvSats))), ...coins }
  const records = useSwapRecords()
  const payLabel = useId()
  const getLabel = useId()
  const payLeg = useRef<HTMLElement>(null)
  const getLeg = useRef<HTMLElement>(null)

  const machine = useMemo(
    () =>
      swapMachine.provide({
        actors: {
          quote: fromPromise(({ input }) => quoteSwap(input, { listOffers: listSwapOffers, self: identityKey })),
          execute: fromPromise(({ input }) => runSwap(input, walletSwapPorts(address))),
          publish: fromPromise(({ input }) => publishOwnSwapOffer(input)),
        },
      }),
    [address, identityKey],
  )
  const [snap, send] = useMachine(machine)
  const { request, quote, picked, refusal, started, failure, draft, published } = snap.context
  const directSwaps = useDirectSwaps()

  const [pair, setPair] = useState(() => defaultPair(held))
  const { from, to } = pair
  const [amount, setAmount] = useState('')
  const pay = decimalToUnits(from, amount) ?? 0n
  const overBalance = pay > held[from]
  const asked = pay > 0n && !overBalance
  /** The chart's quote answers exactly what the form asks now. */
  const current = request?.from === from && request.to === to && request.pay === pay

  const view =
    snap.matches('reviewing') || snap.matches('swapping')
      ? 'review'
      : snap.matches('offering') || snap.matches('publishing')
        ? 'offer'
        : snap.matches('done') || snap.matches('failed') || snap.matches('published')
          ? 'result'
          : 'form'
  const editable = view === 'form'

  useEffect(() => {
    for (const asset of SWAP_ASSETS) void refreshBsvMarket(false, asset)
  }, [])

  useEffect(() => {
    if (!editable || !asked || current) return
    const timer = setTimeout(() => send({ type: 'QUOTE', request: { from, to, pay } }), QUOTE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // Quote again only when what is asked changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, from, to, pay, overBalance])

  useEffect(() => {
    if (snap.matches('done') && started) {
      playPaymentSuccessSound()
      toastSuccess('Swap started', startedText(started))
      setAmount('')
    }
    if (snap.matches('published')) {
      playPaymentSuccessSound()
      setAmount('')
    }
    if (snap.matches('failed') && failure) {
      playWalletSound('error')
      onFail(failure.message)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  const openCount = records.filter((r) => r.stage === 'paid' && !EXOLIX_FINAL.includes(r.status)).length
  useEffect(() => {
    if (openCount === 0) return
    void refreshSwapRecords()
    const timer = setInterval(() => {
      if (!document.hidden) void refreshSwapRecords()
    }, STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [openCount])

  const chosen = current ? (quote?.routes[picked] ?? null) : null
  const pick = (leg: 'from' | 'to') => (next: SwapAsset) => {
    playWalletSound('soft')
    setPair((p) => {
      const other = leg === 'from' ? p.to : p.from
      if (next !== other) return leg === 'from' ? { from: next, to: p.to } : { from: p.from, to: next }
      return { from: p.to, to: p.from }
    })
  }

  const offerDraft =
    snap.matches('refused') && refusal?.kind === 'no-route' && current
      ? draftOfferAtMarket({ from, to, pay, held: held[from] }, (a) => getCachedBsvMarket(a)?.priceUsd ?? null)
      : null

  const cta: { label: string; disabled: boolean; pending?: boolean; onClick?: () => void } =
    pay <= 0n
      ? { label: 'Enter an amount', disabled: true }
      : overBalance
        ? { label: `Not enough ${SWAP_ASSET_INFO[from].ticker}`, disabled: true }
        : !current || snap.matches('quoting')
          ? { label: 'Finding the best price…', disabled: true, pending: true }
          : snap.matches('stale')
            ? { label: 'Get a new price', disabled: false, onClick: () => send({ type: 'QUOTE', request: { from, to, pay } }) }
            : snap.matches('quoted') && chosen
              ? { label: 'Review swap', disabled: false, onClick: () => send({ type: 'REVIEW' }) }
              : offerDraft?.ok
                  ? {
                      label: 'Publish an offer',
                      disabled: false,
                      onClick: () => {
                        playWalletSound('soft')
                        send({ type: 'OFFER', draft: offerDraft.draft })
                      },
                    }
                  : { label: 'Review swap', disabled: true }

  const payUsd = pay > 0n ? usdOf(from, pay) : null
  const getUsd = chosen ? usdOf(to, chosen.receive) : null

  const recent = [
    ...directSwaps.map((swap) => ({ key: swap.swapId, route: 'direct', from: swap.from, to: swap.to, raw: swap.state, state: stateToAttr(swap.state), label: swap.title, detail: swap.status })),
    ...records.map((r) => ({
      key: r.id,
      route: 'exolix',
      from: r.from,
      to: r.to,
      raw: r.stage === 'paid' ? r.status : r.stage,
      state: stateToAttr(r.stage === 'paid' ? r.status : r.stage),
      label: `${fmt(r.from, BigInt(r.pay))} → ${fmt(r.to, BigInt(r.receive))}`,
      detail: recordText(r),
    })),
  ].slice(0, RECENT_SWAPS)

  return (
    <div className="nav-child-panel" data-aeon-scope="swap" data-aeon-state={stateToAttr(snap.value)}>
      {view === 'form' ? (
        <>
          <p data-aeon-part="lede">Between coins in this wallet. No addresses to paste.</p>

          <div data-aeon-part="pair">
            <section ref={payLeg} data-aeon-part="leg" aria-label="You pay">
              <div data-aeon-part="leg-head">
                <span data-aeon-part="leg-label" id={payLabel}>
                  You pay
                </span>
                <span data-aeon-part="held" data-aeon-state={overBalance ? 'over' : 'ok'}>
                  Held {fmt(from, held[from])}
                </span>
              </div>
              <div data-aeon-part="leg-row">
                <input
                  data-aeon-part="amount"
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-label={`Amount of ${SWAP_ASSET_INFO[from].ticker} to pay`}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
                />
                <CoinSelect
                  value={from}
                  labelledBy={payLabel}
                  anchorRef={payLeg}
                  onChange={(c) => pick('from')(c as SwapAsset)}
                  detail={(c) => unitsToDecimal(c as SwapAsset, held[c as SwapAsset])}
                  unavailable={(c) => held[c as SwapAsset] === 0n}
                />
              </div>
              <span data-aeon-part="fiat">{payUsd != null ? `≈ ${usdText(payUsd)}` : '\u00a0'}</span>
            </section>

            <button
              type="button"
              data-aeon-part="flip"
              aria-label="Swap direction"
              disabled={held[to] === 0n}
              onClick={() => {
                playWalletSound('soft')
                setPair({ from: to, to: from })
                setAmount('')
              }}
            >
              <SwapIcon size={18} />
            </button>

            <section ref={getLeg} data-aeon-part="leg" aria-label="You receive">
              <div data-aeon-part="leg-head">
                <span data-aeon-part="leg-label" id={getLabel}>
                  You receive
                </span>
              </div>
              <div data-aeon-part="leg-row">
                <output data-aeon-part="receive" data-aeon-state={chosen ? 'quoted' : 'empty'} aria-live="polite">
                  {chosen ? unitsToDecimal(to, chosen.receive) : '0.00'}
                </output>
                <CoinSelect value={to} labelledBy={getLabel} anchorRef={getLeg} onChange={(c) => pick('to')(c as SwapAsset)} />
              </div>
              <span data-aeon-part="fiat">{getUsd != null ? `≈ ${usdText(getUsd)}` : '\u00a0'}</span>
            </section>

          </div>

          {chosen && snap.matches('quoted') && quote ? (
            quote.routes.length > 1 ? (
              <ul data-aeon-part="routes" role="radiogroup" aria-label="Route">
                {quote.routes.map((route, index) => (
                  <li key={route.kind === 'direct' ? route.offer.nonce : 'exolix'}>
                    <ListRow.Root
                      as="button"
                      type="button"
                      role="radio"
                      aria-checked={index === picked}
                      data-aeon-state={stateToAttr(index === picked ? 'selected' : 'idle')}
                      data-route={route.kind}
                      onClick={() => send({ type: 'PICK', index })}
                    >
                      <ListRow.Leading>
                        <SwapRouteBadge kind={route.kind} />
                      </ListRow.Leading>
                      <ListRow.Label>{routeName(route)}</ListRow.Label>
                      <ListRow.Description>{routeNote(route)}</ListRow.Description>
                      <ListRow.Trailing>{fmt(to, route.receive)}</ListRow.Trailing>
                    </ListRow.Root>
                  </li>
                ))}
              </ul>
            ) : (
              <p data-aeon-part="rate">
                {rateText(from, to, chosen)} · via {routeName(chosen)}
              </p>
            )
          ) : null}

          {snap.matches('refused') && refusal && current ? (
            <StatusBanner.Root tone="warning" status="refused">
              <StatusBanner.Copy>
                <StatusBanner.Body>
                  {refusalText(refusal, from)}
                  {offerDraft?.ok ? ' You can publish this amount as an offer for another wallet to take.' : ''}
                </StatusBanner.Body>
              </StatusBanner.Copy>
            </StatusBanner.Root>
          ) : null}

          <footer data-aeon-part="actions">
            <Button.Root className="btn btn-primary" variant="solid" size="lg" disabled={cta.disabled} status={cta.pending ? 'pending' : 'idle'} onClick={cta.onClick}>
              <Button.Label>{cta.label}</Button.Label>
            </Button.Root>
            <Button.Root variant="ghost" size="sm" data-aeon-part="browse" onClick={openSwapOffers}>
              <Button.Label>Browse swap offers</Button.Label>
            </Button.Root>
          </footer>
        </>
      ) : null}

      {view === 'offer' && draft ? (
        <OfferStep
          draft={draft}
          onParts={(allow) => {
            playWalletSound('soft')
            send({ type: 'PARTS', allow })
          }}
          publishing={snap.matches('publishing')}
          failure={failure?.message ?? null}
          onBack={() => send({ type: 'BACK' })}
          onPublish={() => {
            playWalletSound('soft')
            send({ type: 'PUBLISH' })
          }}
        />
      ) : null}

      {view === 'review' && quote ? (
        <ReviewStep
          from={quote.request.from}
          to={quote.request.to}
          route={quote.routes[picked]!}
          swapping={snap.matches('swapping')}
          onBack={() => send({ type: 'BACK' })}
          onConfirm={() => {
            playWalletSound('soft')
            send({ type: 'CONFIRM' })
          }}
        />
      ) : null}

      {view === 'result' && snap.matches('published') && published ? (
        <StatusBanner.Root tone="success" status="published">
          <StatusBanner.Copy>
            <StatusBanner.Title>Offer published</StatusBanner.Title>
            <StatusBanner.Body>
              {fmt(published.give, fillOffer(published, BigInt(published.maxGet)) ?? 0n)} for {fmt(published.get, BigInt(published.maxGet))}, listed for 24 hours. Nothing has left this wallet.
            </StatusBanner.Body>
          </StatusBanner.Copy>
          <StatusBanner.Actions>
            <StatusBanner.Action className="btn btn-ghost" onClick={openSwapOffers}>See offers</StatusBanner.Action>
            <StatusBanner.Action className="btn btn-ghost" onClick={() => send({ type: 'RESET' })}>New swap</StatusBanner.Action>
          </StatusBanner.Actions>
        </StatusBanner.Root>
      ) : null}

      {view === 'result' && !snap.matches('published') ? (
        <StatusBanner.Root tone={snap.matches('done') ? 'success' : 'danger'} status={snap.matches('done') ? 'done' : 'failed'}>
          <StatusBanner.Copy>
            <StatusBanner.Title>{snap.matches('done') ? 'Swap started' : 'Swap not started'}</StatusBanner.Title>
            <StatusBanner.Body>
              {snap.matches('done') && started ? `${startedText(started)} Progress shows below.` : (failure?.message ?? '')}
            </StatusBanner.Body>
          </StatusBanner.Copy>
          <StatusBanner.Actions>
            <StatusBanner.Action className="btn btn-ghost" onClick={() => send({ type: 'RESET' })}>{snap.matches('done') ? 'New swap' : 'Try again'}</StatusBanner.Action>
          </StatusBanner.Actions>
        </StatusBanner.Root>
      ) : null}

      {view !== 'review' && view !== 'offer' && recent.length > 0 ? (
        <section data-aeon-part="history" aria-label="Recent swaps">
          <span data-aeon-part="leg-label">Recent swaps</span>
          <ul>
            {recent.map((row) => (
              <li key={row.key}>
                <ListRow.Root data-aeon-state={row.state} data-route={row.route}>
                  <ListRow.Leading>
                    <SwapPairMark from={row.from} to={row.to} />
                  </ListRow.Leading>
                  <ListRow.Label>{row.label}</ListRow.Label>
                  <ListRow.Description>{row.detail}</ListRow.Description>
                  <ListRow.Trailing>
                    <SwapStatusPill state={row.raw} />
                  </ListRow.Trailing>
                </ListRow.Root>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function ReviewStep({
  from,
  to,
  route,
  swapping,
  onBack,
  onConfirm,
}: {
  from: SwapAsset
  to: SwapAsset
  route: SwapRoute
  swapping: boolean
  onBack: () => void
  onConfirm: () => void
}) {
  return (
    <section data-aeon-part="review" aria-label="Confirm swap">
      <SwapSummary pay={{ asset: from, units: route.pay, caption: 'You pay' }} receive={{ asset: to, units: route.receive, caption: 'You receive' }} />
      <dl>
        <dt>Rate</dt>
        <dd>{route.kind === 'exolix' ? `${rateText(from, to, route)}, fixed for about a minute` : `${rateText(from, to, route)}, signed by the maker`}</dd>
        <dt>Through</dt>
        <dd>{route.kind === 'exolix' ? 'Exolix. If it cannot finish, it refunds this wallet.' : routeName(route)}</dd>
        {route.kind === 'direct' ? (
          <>
            <dt>Fee</dt>
            <dd>
              {route.fee > 0n
                ? `${fmt(feeLegOf(route.offer) === 'taker' ? from : to, route.fee)} (0.5%), ${feeLegOf(route.offer) === 'taker' ? 'included in what you pay' : 'taken from what you receive'}; charged only if the swap completes`
                : 'None on a swap this small'}
            </dd>
            <dt>Timing</dt>
            <dd>
              You lock now. The maker need not be online: it has up to {hours(MAKER_FUND_WITHIN_S)} to lock its side, and this wallet claims once that lock confirms. Its lock stands for {hours(MAKER_LOCK_S)}, yours for {Math.round(TAKER_LOCK_S / 86_400)} days; network fees are paid on top.
            </dd>
          </>
        ) : null}
      </dl>
      {route.kind === 'exolix' ? (
        <StatusBanner.Root tone="warning" status="custodial">
          <StatusBanner.Copy>
            <StatusBanner.Title>Exolix holds your coins while it swaps</StatusBanner.Title>
            <StatusBanner.Body>From your deposit until its payout to this wallet. Your deposit's network fee is paid on top.</StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : (
        <StatusBanner.Root tone="info" status="trustless">
          <StatusBanner.Copy>
            <StatusBanner.Title>Both sides complete, or both are refunded</StatusBanner.Title>
            <StatusBanner.Body>
              Coins are locked on their own chains, never held by anyone. If the maker declines (someone filled the offer first) or never locks, your coins come back to this wallet after {Math.round(TAKER_LOCK_S / 86_400)} days.
            </StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      )}
      <Button.Group>
        <Button.Root className="btn btn-ghost" variant="ghost" disabled={swapping} onClick={onBack}>
          <Button.Label>Back</Button.Label>
        </Button.Root>
        <Button.Root className="btn btn-primary" variant="solid" size="lg" status={swapping ? 'pending' : 'idle'} disabled={swapping} onClick={onConfirm}>
          <Button.Label>{swapping ? 'Swapping…' : 'Confirm swap'}</Button.Label>
        </Button.Root>
      </Button.Group>
    </section>
  )
}

function OfferStep({
  draft,
  onParts,
  publishing,
  failure,
  onBack,
  onPublish,
}: {
  draft: SwapOfferDraft
  onParts: (allow: boolean) => void
  publishing: boolean
  failure: string | null
  onBack: () => void
  onPublish: () => void
}) {
  const rate = Number(draft.want) / Number(draft.pay)
  return (
    <section data-aeon-part="review" aria-label="Publish swap offer">
      <SwapSummary pay={{ asset: draft.give, units: draft.pay, caption: 'You give' }} receive={{ asset: draft.get, units: draft.want, caption: 'You ask' }} />
      <dl>
        <dt>Rate</dt>
        <dd>
          1 {SWAP_ASSET_INFO[draft.give].ticker} = {rate.toLocaleString(undefined, { maximumFractionDigits: rate >= 100 ? 2 : rate >= 1 ? 4 : 8 })}{' '}
          {SWAP_ASSET_INFO[draft.get].ticker}, today's market rate
        </dd>
        <dt>Listed</dt>
        <dd>
          For 24 hours,{' '}
          {draft.minWant < draft.want ? `in parts of at least ${fmt(draft.get, draft.minWant)}` : 'whole'}. Cancel any time from Offers. A take
          made while you are away is honoured when you next open the wallet, within a day.
        </dd>
      </dl>
      {draft.partWant < draft.want ? (
        <div data-aeon-part="parts" data-aeon-state={draft.minWant < draft.want ? 'on' : 'off'}>
          <span data-aeon-part="parts-label">Let takers fill part of it</span>
          <Switch.Root
            checked={draft.minWant < draft.want}
            aria-label="Let takers fill part of it"
            disabled={publishing}
            onCheckedChange={onParts}
          />
        </div>
      ) : null}
      <StatusBanner.Root tone="info" status="offer">
        <StatusBanner.Copy>
          <StatusBanner.Title>Publishing moves no coins</StatusBanner.Title>
          <StatusBanner.Body>It signs your price for other wallets to see. Offers are taken wallet to wallet, and nothing leaves this wallet until one is.</StatusBanner.Body>
        </StatusBanner.Copy>
      </StatusBanner.Root>
      {failure ? (
        <StatusBanner.Root tone="danger" status="failed">
          <StatusBanner.Copy>
            <StatusBanner.Body>{failure}</StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : null}
      <Button.Group>
        <Button.Root className="btn btn-ghost" variant="ghost" disabled={publishing} onClick={onBack}>
          <Button.Label>Back</Button.Label>
        </Button.Root>
        <Button.Root className="btn btn-primary" variant="solid" size="lg" status={publishing ? 'pending' : 'idle'} disabled={publishing} onClick={onPublish}>
          <Button.Label>{publishing ? 'Publishing…' : 'Publish offer'}</Button.Label>
        </Button.Root>
      </Button.Group>
    </section>
  )
}
