import { useEffect, useId, useMemo, useState } from 'react'
import { useMachine } from '@xstate/react'
import { fromPromise } from 'xstate'
import { stateToAttr } from '@aeon-ui/core'
import { Button, Field, ListRow, StatusBanner } from '@aeon-ui/react'
import { amountFits, roomOf, swapOffersMachine } from '../machines/swapOffersMachine'
import { getCachedBsvMarket, refreshMarketBoard } from '../wallet/bsvMarket'
import { openSwapDetails, openSwapFlow } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { decimalToUnits, SWAP_ASSET_INFO, unitsToDecimal, type SwapAsset } from '../wallet/swap/assets'
import { fillOffer, fillsInParts, type SignedSwapOffer } from '../wallet/swap/offer'
import { browseSwapOfferBook, withOwnTakes } from '../wallet/swap/offerBook'
import { MAKER_FUND_WITHIN_S, previewTake } from '../wallet/swap/settle'
import { cancelOwnSwapOffer, ownTakenOf, takeSwapOffer } from '../wallet/swap/settleRunner'
import { useRecentSwaps } from '../features/swap'
import { SwapPairMark, SwapStatusPill, SwapSummary } from './SwapVisuals'

const fmt = (asset: SwapAsset, units: bigint) => `${unitsToDecimal(asset, units)} ${SWAP_ASSET_INFO[asset].ticker}`

/** What a taker pays and receives for all that is left of the offer (`max`), before the fee. */
function terms(offer: SignedSwapOffer, max = BigInt(offer.maxGet)): { pay: bigint; receive: bigint } {
  return { pay: max, receive: (max * BigInt(offer.price.give)) / BigInt(offer.price.get) }
}

/** The offer against the market rate, from the taker's side: "4% better than market". */
function versusMarket(offer: SignedSwapOffer): string | null {
  const { pay, receive } = terms(offer)
  const give = getCachedBsvMarket(offer.give)?.priceUsd
  const get = getCachedBsvMarket(offer.get)?.priceUsd
  if (!give || !get || pay === 0n) return null
  const pct = ((Number(receive) * give) / (Number(pay) * get) - 1) * 100
  if (Math.abs(pct) < 0.5) return 'At market'
  return `${Math.abs(pct).toFixed(pct > -10 && pct < 10 ? 1 : 0)}% ${pct > 0 ? 'better' : 'worse'} than market`
}

function timeLeft(expiresAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((expiresAt - now) / 60_000))
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h left` : `${minutes}m left`
}

const hours = (seconds: number) => `${Math.round(seconds / 3600)} hours`
const days = (seconds: number) => `${Math.round(seconds / 86_400)} days`

/**
 * The swap offer book: standing offers anyone published from Swap when no
 * route could take their swap. Each is verified here; this wallet's own come
 * first and can be withdrawn. Taking one, all of what is left or a part of
 * an offer that allows it, is reviewed and confirmed here; the wallet then
 * locks its side at once, the maker locks when it next comes online, and
 * this wallet's swaps show their progress at the top.
 */
export function SwapOffersPanel({ identityKey }: { identityKey: string }) {
  const machine = useMemo(
    () =>
      swapOffersMachine.provide({
        actors: {
          load: fromPromise(async () => withOwnTakes(await browseSwapOfferBook(), ownTakenOf())),
          cancel: fromPromise(({ input }) => cancelOwnSwapOffer(input)),
          take: fromPromise(async ({ input }) => {
            await takeSwapOffer(input.offer, input.pay)
          }),
        },
      }),
    [],
  )
  const [snap, send] = useMachine(machine, { input: { self: identityKey } })
  const { offers, cancelling, taking, failure } = snap.context
  const swaps = useRecentSwaps('direct')
  const now = Date.now()

  useEffect(() => {
    void refreshMarketBoard()
  }, [])

  const mine = offers.filter((o) => o.maker === identityKey)
  const others = offers.filter((o) => o.maker !== identityKey)
  const chosen = taking ? offers.find((o) => o.nonce === taking) ?? null : null
  const reviewing = snap.matches('reviewing') || snap.matches('taking') || snap.matches('taken')

  return (
    <div className="nav-child-panel" data-aeon-scope="swap-offers" data-aeon-state={stateToAttr(snap.value)}>

      {failure ? (
        <StatusBanner.Root tone="danger" status="failed">
          <StatusBanner.Copy>
            <StatusBanner.Body>{failure}</StatusBanner.Body>
          </StatusBanner.Copy>
          {snap.matches('failed') ? (
            <StatusBanner.Actions>
              <StatusBanner.Action className="btn btn-ghost" onClick={() => send({ type: 'REFRESH' })}>Try again</StatusBanner.Action>
            </StatusBanner.Actions>
          ) : null}
        </StatusBanner.Root>
      ) : null}

      {swaps.length > 0 && !reviewing ? (
        <section data-aeon-part="swaps" aria-label="Your swaps">
          <span data-aeon-part="leg-label">Your swaps</span>
          <ul>
            {swaps.map((swap) => (
              <li key={swap.id}>
                <ListRow.Root
                  data-aeon-state={stateToAttr(swap.state)}
                  onClick={() => {
                    playWalletSound('soft')
                    openSwapDetails(swap.id)
                  }}
                >
                  <ListRow.Leading>
                    <SwapPairMark from={swap.from} to={swap.to} />
                  </ListRow.Leading>
                  <ListRow.Label>{swap.title}</ListRow.Label>
                  <ListRow.Description>{swap.status}</ListRow.Description>
                  <ListRow.Trailing>
                    <SwapStatusPill tone={swap.tone} />
                  </ListRow.Trailing>
                </ListRow.Root>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {reviewing && chosen ? (
        <TakeReview
          offer={chosen}
          room={roomOf(snap.context, chosen)}
          pay={snap.context.pay}
          fits={amountFits(snap.context)}
          taking={snap.matches('taking')}
          taken={snap.matches('taken')}
          onAmount={(pay) => send({ type: 'AMOUNT', pay })}
          onBack={() => send({ type: 'BACK' })}
          onConfirm={() => {
            playWalletSound('soft')
            send({ type: 'CONFIRM' })
          }}
          onDone={() => send({ type: 'REFRESH' })}
        />
      ) : (
        <>
          {mine.length > 0 ? (
            <section data-aeon-part="offers" aria-label="Your offers">
              <span data-aeon-part="leg-label">Yours</span>
              <ul>
                {mine.map((offer) => {
                  const { pay, receive } = terms(offer)
                  const left = roomOf(snap.context, offer)
                  const busy = cancelling === offer.nonce
                  return (
                    <li key={offer.nonce}>
                      <ListRow.Root data-aeon-state={stateToAttr(busy ? 'cancelling' : 'open')}>
                        <ListRow.Leading>
                          <SwapPairMark from={offer.give} to={offer.get} />
                        </ListRow.Leading>
                        <ListRow.Label>
                          You give {fmt(offer.give, receive)} for {fmt(offer.get, pay)}
                        </ListRow.Label>
                        <ListRow.Description>
                          {[fillsInParts(offer) ? (left && left.max < pay ? `${fmt(offer.get, left.max)} left` : 'In parts') : null, timeLeft(offer.expiresAt, now)].filter(Boolean).join(' · ')}
                        </ListRow.Description>
                        <ListRow.Trailing>
                          <Button.Root
                            className="btn btn-ghost"
                            variant="ghost"
                            size="sm"
                            status={busy ? 'pending' : 'idle'}
                            disabled={!snap.matches('ready')}
                            onClick={() => {
                              playWalletSound('soft')
                              send({ type: 'CANCEL', nonce: offer.nonce })
                            }}
                          >
                            <Button.Label>{busy ? 'Cancelling…' : 'Cancel'}</Button.Label>
                          </Button.Root>
                        </ListRow.Trailing>
                      </ListRow.Root>
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}

          <section data-aeon-part="offers" aria-label="Open offers" aria-busy={snap.matches('loading')}>
            <span data-aeon-part="leg-label">Open offers</span>
            {snap.matches('loading') && offers.length === 0 ? (
              <p data-aeon-part="empty">Loading offers…</p>
            ) : others.length === 0 ? (
              <p data-aeon-part="empty">No open offers right now.</p>
            ) : (
              <ul>
                {others.map((offer) => {
                  const left = roomOf(snap.context, offer)
                  const { pay, receive } = terms(offer, left?.max ?? 0n)
                  const market = versusMarket(offer)
                  const parts = fillsInParts(offer)
                  const takeable = !!left && (previewTake(offer, left.min) !== null || previewTake(offer, left.max) !== null)
                  return (
                    <li key={offer.nonce}>
                      <ListRow.Root data-aeon-state={stateToAttr(takeable ? 'open' : 'too-small')}>
                        <ListRow.Leading>
                          <SwapPairMark from={offer.get} to={offer.give} />
                        </ListRow.Leading>
                        <ListRow.Label>
                          Get {parts ? 'up to ' : ''}
                          {fmt(offer.give, receive)} for {fmt(offer.get, pay)}
                        </ListRow.Label>
                        <ListRow.Description>
                          {[parts && left ? `from ${fmt(offer.get, left.min)}` : null, market, timeLeft(offer.expiresAt, now), `${offer.maker.slice(0, 10)}…`].filter(Boolean).join(' · ')}
                        </ListRow.Description>
                        <ListRow.Trailing>
                          <Button.Root
                            className="btn btn-ghost"
                            variant="ghost"
                            size="sm"
                            disabled={!snap.matches('ready') || !takeable}
                            onClick={() => send({ type: 'REVIEW', nonce: offer.nonce })}
                          >
                            <Button.Label>{takeable ? 'Take' : 'Too small'}</Button.Label>
                          </Button.Root>
                        </ListRow.Trailing>
                      </ListRow.Root>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <Button.Group>
            <Button.Root className="btn btn-ghost" variant="ghost" onClick={openSwapFlow}>
              <Button.Label>Back to swap</Button.Label>
            </Button.Root>
            <Button.Root
              className="btn btn-ghost"
              variant="ghost"
              status={snap.matches('loading') ? 'pending' : 'idle'}
              disabled={!snap.matches('ready') && !snap.matches('failed')}
              onClick={() => send({ type: 'REFRESH' })}
            >
              <Button.Label>Refresh</Button.Label>
            </Button.Root>
          </Button.Group>
        </>
      )}
    </div>
  )
}

function TakeReview({
  offer,
  room,
  pay,
  fits,
  taking,
  taken,
  onAmount,
  onBack,
  onConfirm,
  onDone,
}: {
  offer: SignedSwapOffer
  room: { min: bigint; max: bigint } | null
  pay: bigint | null
  fits: boolean
  taking: boolean
  taken: boolean
  onAmount: (pay: bigint | null) => void
  onBack: () => void
  onConfirm: () => void
  onDone: () => void
}) {
  const amountId = useId()
  const [amount, setAmount] = useState(() => (pay !== null ? unitsToDecimal(offer.get, pay) : ''))
  const preview = pay !== null && fits ? previewTake(offer, pay) : null
  const shown = preview ?? (room ? previewTake(offer, room.max) : null)
  if (!shown || !room) return null
  const feeAsset = shown.feeLeg === 'taker' ? offer.get : offer.give
  const parts = fillsInParts(offer) && room.min < room.max
  return (
    <section data-aeon-part="review" aria-label="Take swap offer">
      {parts ? (
        <Field.Root data-aeon-part="take-amount" data-aeon-state={fits ? 'fits' : 'out-of-range'}>
          <Field.Label htmlFor={amountId}>{SWAP_ASSET_INFO[offer.get].ticker} to put in</Field.Label>
          <Field.Control
            id={amountId}
            inputMode="decimal"
            value={amount}
            disabled={taking || taken}
            onChange={(e) => {
              const text = e.target.value.replace(',', '.')
              setAmount(text)
              onAmount(decimalToUnits(offer.get, text))
            }}
          />
          <Field.Hint>
            This offer can be filled in parts: from {fmt(offer.get, room.min)} up to {fmt(offer.get, room.max)}.
          </Field.Hint>
        </Field.Root>
      ) : null}
      <SwapSummary
        pay={{ asset: offer.get, units: shown.pays, caption: 'You lock' }}
        receive={{ asset: offer.give, units: preview ? shown.receives : fillOffer(offer, room.max) ?? 0n, caption: 'You receive' }}
      />
      <dl>
        <dt>Fee</dt>
        <dd>
          {shown.fee > 0n
            ? `${fmt(feeAsset, shown.fee)} (0.5%), ${shown.feeLeg === 'taker' ? 'included in what you lock' : 'taken from what you receive'}; charged only if the swap completes`
            : 'None on a swap this small'}
        </dd>
        <dt>Timing</dt>
        <dd>
          You lock now. The maker need not be online: it has up to {hours(MAKER_FUND_WITHIN_S)} to lock its side, and this wallet claims once that lock confirms. Its lock stands for {hours(shown.makerLockS)}, yours for {days(shown.takerLockS)}; network fees are paid on top.
        </dd>
      </dl>
      {taken ? (
        <StatusBanner.Root tone="success" status="taken">
          <StatusBanner.Copy>
            <StatusBanner.Title>Take sent</StatusBanner.Title>
            <StatusBanner.Body>
              This wallet locks your {SWAP_ASSET_INFO[offer.get].ticker} now and claims your {SWAP_ASSET_INFO[offer.give].ticker} once the maker locks its side, which can take up to {hours(MAKER_FUND_WITHIN_S)}. Open the wallet at least once a day until the swap shows Swapped.
            </StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : (
        <StatusBanner.Root tone="info" status="trustless">
          <StatusBanner.Copy>
            <StatusBanner.Title>Both sides complete, or both are refunded</StatusBanner.Title>
            <StatusBanner.Body>
              Coins are locked on their own chains, never held by anyone. If the maker declines (someone filled the offer first) or never locks, your coins come back to this wallet after {days(shown.takerLockS)}.
            </StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      )}
      <Button.Group>
        {taken ? (
          <Button.Root className="btn btn-primary" variant="solid" size="lg" onClick={onDone}>
            <Button.Label>Done</Button.Label>
          </Button.Root>
        ) : (
          <>
            <Button.Root className="btn btn-ghost" variant="ghost" disabled={taking} onClick={onBack}>
              <Button.Label>Back</Button.Label>
            </Button.Root>
            <Button.Root className="btn btn-primary" variant="solid" size="lg" status={taking ? 'pending' : 'idle'} disabled={taking || !fits} onClick={onConfirm}>
              <Button.Label>{taking ? 'Sending…' : 'Confirm swap'}</Button.Label>
            </Button.Root>
          </>
        )}
      </Button.Group>
    </section>
  )
}
