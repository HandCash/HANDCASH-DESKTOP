import { useEffect, useMemo } from 'react'
import { useMachine } from '@xstate/react'
import { fromPromise } from 'xstate'
import { stateToAttr } from '@aeon-ui/core'
import { Button, ListRow, StatusBanner } from '@aeon-ui/react'
import { swapOffersMachine } from '../machines/swapOffersMachine'
import { getCachedBsvMarket, refreshBsvMarket } from '../wallet/bsvMarket'
import { openSwapFlow } from '../wallet/navStore'
import { playWalletSound } from '../wallet/soundService'
import { SWAP_ASSET_INFO, SWAP_ASSETS, unitsToDecimal, type SwapAsset } from '../wallet/swap/assets'
import { fillOffer, type SignedSwapOffer } from '../wallet/swap/offer'
import { browseSwapOffers } from '../wallet/swap/offerBook'
import { previewTake } from '../wallet/swap/settle'
import { cancelOwnSwapOffer, takeSwapOffer } from '../wallet/swap/settleRunner'
import { useDirectSwaps } from '../features/swap'
import { SwapPairMark, SwapStatusPill, SwapSummary } from './SwapVisuals'

const fmt = (asset: SwapAsset, units: bigint) => `${unitsToDecimal(asset, units)} ${SWAP_ASSET_INFO[asset].ticker}`

/** What a taker pays and receives for the whole offer, before the fee. */
function terms(offer: SignedSwapOffer): { pay: bigint; receive: bigint } {
  const pay = BigInt(offer.maxGet)
  return { pay, receive: fillOffer(offer, pay) ?? 0n }
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

/**
 * The swap offer book: standing offers anyone published from Swap when no
 * route could take their swap. Each is verified here; this wallet's own come
 * first and can be withdrawn. Taking one is reviewed and confirmed here; the
 * wallet then locks its side once the maker accepts, and this wallet's swaps
 * show their progress at the top.
 */
export function SwapOffersPanel({ identityKey }: { identityKey: string }) {
  const machine = useMemo(
    () =>
      swapOffersMachine.provide({
        actors: {
          load: fromPromise(() => browseSwapOffers()),
          cancel: fromPromise(({ input }) => cancelOwnSwapOffer(input)),
          take: fromPromise(async ({ input }) => {
            await takeSwapOffer(input, BigInt(input.maxGet))
          }),
        },
      }),
    [],
  )
  const [snap, send] = useMachine(machine, { input: { self: identityKey } })
  const { offers, cancelling, taking, failure } = snap.context
  const swaps = useDirectSwaps()
  const now = Date.now()

  useEffect(() => {
    for (const asset of SWAP_ASSETS) void refreshBsvMarket(false, asset)
  }, [])

  const mine = offers.filter((o) => o.maker === identityKey)
  const others = offers.filter((o) => o.maker !== identityKey)
  const chosen = taking ? offers.find((o) => o.nonce === taking) ?? null : null
  const reviewing = snap.matches('reviewing') || snap.matches('taking') || snap.matches('taken')

  return (
    <div className="nav-child-panel" data-aeon-scope="swap-offers" data-aeon-state={stateToAttr(snap.value)}>
      <p data-aeon-part="lede">Standing prices other wallets signed. Taken wallet to wallet: both sides complete or both are refunded, and nobody holds the coins.</p>

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
              <li key={swap.swapId}>
                <ListRow.Root data-aeon-state={stateToAttr(swap.state)}>
                  <ListRow.Leading>
                    <SwapPairMark from={swap.from} to={swap.to} />
                  </ListRow.Leading>
                  <ListRow.Label>{swap.title}</ListRow.Label>
                  <ListRow.Description>{swap.status}</ListRow.Description>
                  <ListRow.Trailing>
                    <SwapStatusPill state={swap.state} />
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
          taking={snap.matches('taking')}
          taken={snap.matches('taken')}
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
                        <ListRow.Description>{timeLeft(offer.expiresAt, now)}</ListRow.Description>
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
                  const { pay, receive } = terms(offer)
                  const market = versusMarket(offer)
                  const takeable = previewTake(offer, pay) !== null
                  return (
                    <li key={offer.nonce}>
                      <ListRow.Root data-aeon-state={stateToAttr(takeable ? 'open' : 'too-small')}>
                        <ListRow.Leading>
                          <SwapPairMark from={offer.get} to={offer.give} />
                        </ListRow.Leading>
                        <ListRow.Label>
                          Get {fmt(offer.give, receive)} for {fmt(offer.get, pay)}
                        </ListRow.Label>
                        <ListRow.Description>
                          {[market, timeLeft(offer.expiresAt, now), `${offer.maker.slice(0, 10)}…`].filter(Boolean).join(' · ')}
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
  taking,
  taken,
  onBack,
  onConfirm,
  onDone,
}: {
  offer: SignedSwapOffer
  taking: boolean
  taken: boolean
  onBack: () => void
  onConfirm: () => void
  onDone: () => void
}) {
  const preview = previewTake(offer, BigInt(offer.maxGet))
  if (!preview) return null
  const feeAsset = preview.feeLeg === 'taker' ? offer.get : offer.give
  return (
    <section data-aeon-part="review" aria-label="Take swap offer">
      <SwapSummary pay={{ asset: offer.get, units: preview.pays, caption: 'You lock' }} receive={{ asset: offer.give, units: preview.receives, caption: 'You receive' }} />
      <dl>
        <dt>Fee</dt>
        <dd>
          {preview.fee > 0n
            ? `${fmt(feeAsset, preview.fee)} (0.5%), ${preview.feeLeg === 'taker' ? 'included in what you lock' : 'taken from what you receive'}; charged only if the swap completes`
            : 'None on a swap this small'}
        </dd>
        <dt>Timing</dt>
        <dd>
          The maker locks for {hours(preview.makerLockS)}, you for {hours(preview.takerLockS)}. Each side waits for the other's lock to confirm on its chain; network fees are paid on top.
        </dd>
      </dl>
      {taken ? (
        <StatusBanner.Root tone="success" status="taken">
          <StatusBanner.Copy>
            <StatusBanner.Title>Take sent</StatusBanner.Title>
            <StatusBanner.Body>
              This wallet locks your {SWAP_ASSET_INFO[offer.get].ticker} when the maker accepts and claims your {SWAP_ASSET_INFO[offer.give].ticker} on its own. Keep it open until the swap shows Swapped.
            </StatusBanner.Body>
          </StatusBanner.Copy>
        </StatusBanner.Root>
      ) : (
        <StatusBanner.Root tone="info" status="trustless">
          <StatusBanner.Copy>
            <StatusBanner.Title>Both sides complete, or both are refunded</StatusBanner.Title>
            <StatusBanner.Body>
              Coins are locked on their own chains, never held by anyone. If the maker does not lock, or the swap stalls, your coins come back to this wallet after your lock time.
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
            <Button.Root className="btn btn-primary" variant="solid" size="lg" status={taking ? 'pending' : 'idle'} disabled={taking} onClick={onConfirm}>
              <Button.Label>{taking ? 'Sending…' : 'Confirm swap'}</Button.Label>
            </Button.Root>
          </>
        )}
      </Button.Group>
    </section>
  )
}
