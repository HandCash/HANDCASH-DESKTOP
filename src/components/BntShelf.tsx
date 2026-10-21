import { Button, Field, useWindowedRange } from '@aeon-ui/react'
import { startTransition, useEffect, useRef, useState } from 'react'
import { stateToAttr } from '@aeon-ui/core'
import { useMachine } from '@xstate/react'
import type { SnapshotFrom } from 'xstate'
import { bntHoldingsMachine } from '../machines/bntHoldingsMachine'
import { bntHoldingsCache, openWalletCacheKey } from '../wallet/walletCaches'
import { subscribeAppActivity } from '../features/activity'
import { asyncActionError, useAsyncAction } from '../hooks/useAsyncAction'
import { AsyncActionPrompt } from './AsyncActionPrompt'
import { AmountPad, amountInputProps, useAmountPad } from './AmountPad'
import { FungibleTokenFace } from './FungibleTokenFace'
import { burnBntAsset, preflightBntBurn, transferBntAsset, type BntAssetSummary } from '../wallet/bnt/wallet'
import { formatTokenAmount, parseTokenAmount } from '../wallet/amounts'
import { resolvePinnedHandle } from '../wallet/friends'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import type { CollectionView } from '../wallet/collectionView'

const IDENTITY_KEY = /^0[23][0-9a-f]{64}$/i

const holdingsMachine = bntHoldingsMachine.provide({ actors: { holdings: bntHoldingsCache.actor } })

export type Holdings = {
  snapshot: SnapshotFrom<typeof bntHoldingsMachine>
  send: ReturnType<typeof useMachine<typeof holdingsMachine>>[1]
}

/**
 * One holdings chart per Collectables view, served from the shared holdings
 * cache. Any wallet activity (issue, send, receive, account switch)
 * revalidates it under the account open now.
 */
export function useBntHoldings(): Holdings {
  const [snapshot, send] = useMachine(holdingsMachine, { input: { key: openWalletCacheKey() } })
  useEffect(
    () => subscribeAppActivity(() => startTransition(() => send({ type: 'REFRESH', key: openWalletCacheKey() }))),
    [send],
  )
  return { snapshot, send }
}

function label(asset: BntAssetSummary): string {
  return asset.sym || asset.name || `${asset.assetId.slice(0, 8)}…`
}

function amountOf(asset: BntAssetSummary): string {
  return formatTokenAmount(asset.balance, asset.dec ?? 0)
}

function movableOf(asset: BntAssetSummary): bigint {
  return BigInt(asset.balance || '0') - BigInt(asset.locked ?? '0')
}

/** The deploy's supply policy in words; items have none of their own. */
export function bntSupplyLabel(asset: BntAssetSummary): string | null {
  if (asset.kind === 'item') return null
  const { supply } = asset
  if (supply.policy === 'fixed') return 'Fixed supply'
  if (supply.policy === 'open') return 'Open supply, no cap'
  const units = (n: string) => `${formatTokenAmount(n, asset.dec ?? 0)} ${label(asset)}`
  const caps = [
    supply.max != null ? (supply.issued ? `${units(supply.issued.units)} of ${units(supply.max)} minted` : `capped at ${units(supply.max)}`) : '',
    supply.size != null ? (supply.issued ? `${supply.issued.members} of ${supply.size} items` : `up to ${supply.size} items`) : '',
  ].filter(Boolean)
  return `Capped supply: ${caps.join(', ')}`
}

export type BntChipActions = {
  /** The asset whose send form is open. */
  composing: string | null
  open: (assetId: string) => void
}

/** One BNT token or item in an issuer's strip; tapping opens its send form. */
export function BntChip({ asset, view, actions }: { asset: BntAssetSummary; view: CollectionView; actions: BntChipActions }) {
  const amount = asset.kind === 'item' ? (asset.collection ? 'Collection item' : 'Item') : amountOf(asset)
  const supply = bntSupplyLabel(asset)
  return (
    <li
      className="token-chip"
      data-aeon-part="token"
      data-aeon-state={asset.assetId === actions.composing ? 'composing' : 'idle'}
    >
      <button
        type="button"
        className="token-chip-main"
        onClick={() => {
          playWalletSound('soft')
          actions.open(asset.assetId)
        }}
        title={supply ? `${label(asset)} · BNT · ${supply}` : `${label(asset)} · BNT`}
        aria-label={`${label(asset)}, ${amount}, BNT. Send`}
      >
        <span className="collectable-media collectable-media-sm collectable-media-token token-chip-face">
          <FungibleTokenFace
            tokenId={asset.assetId}
            sym={label(asset)}
            iconUrl={asset.imageUrl}
            size={view === 'grid' ? 72 : 56}
          />
        </span>
        <strong className="token-chip-sym" title={label(asset)}>
          {label(asset)}
        </strong>
        <span className="fungible-card-amount token-chip-amount">{amount}</span>
      </button>
    </li>
  )
}

export function bntChipActions(holdings: Holdings): BntChipActions {
  return {
    composing: holdings.snapshot.context.composing,
    open: (assetId) => holdings.send({ type: 'OPEN', assetId }),
  }
}

/**
 * Horizontal strip of token chips, loose and inside an issuer. A wallet holding
 * hundreds of one issuer's assets mounts only the chips in view.
 */
export function TokenShelf({
  assets,
  actions,
  view,
  label,
}: {
  assets: readonly BntAssetSummary[]
  actions: BntChipActions
  view: CollectionView
  label?: string
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const windowed = useWindowedRange({
    total: assets.length,
    itemExtent: view === 'grid' ? 100 : 82,
    overscan: 4,
    axis: 'x',
    scrollRef: listRef,
  })
  return (
    <ul
      ref={listRef}
      className="token-strip"
      role="list"
      aria-label={label}
      data-aeon-part="token-strip"
      data-aeon-state={view}
      style={
        windowed.padStart > 0 || windowed.padEnd > 0
          ? { paddingInlineStart: windowed.padStart, paddingInlineEnd: windowed.padEnd }
          : undefined
      }
    >
      {assets.slice(windowed.start, windowed.end).map((asset) => (
        <BntChip key={asset.assetId} asset={asset} view={view} actions={actions} />
      ))}
    </ul>
  )
}

/**
 * Panel-level BNT surface: the read failure, assets with no usable issuer,
 * and the one send form. Assets with an issuer render on that issuer's shelf.
 */
export function BntShelf({
  holdings,
  view,
  ungrouped,
}: {
  holdings: Holdings
  view: CollectionView
  ungrouped: readonly BntAssetSummary[]
}) {
  const { snapshot, send } = holdings
  const { assets, composing, error, cache } = snapshot.context
  const open = composing ? assets.find((a) => a.assetId === composing) ?? null : null
  const failed = snapshot.matches('failed')
  if (!failed && !open && ungrouped.length === 0) return null
  const actions = bntChipActions(holdings)

  return (
    <div data-aeon-scope="bnt-holdings" data-aeon-state={stateToAttr(snapshot.value)}>
      {failed ? (
        <div className="settings-row" data-aeon-part="failed">
          <span className="settings-row-desc">BNT holdings could not be read: {error}</span>
          <Button.Root variant="ghost" className="btn btn-ghost" onClick={() => send({ type: 'REFRESH' })}>
            <Button.Label>Retry</Button.Label>
          </Button.Root>
        </div>
      ) : null}
      {ungrouped.length > 0 ? (
        <section
          className="collect-tokens-section"
          aria-label="BNT assets without an issuer"
          aria-busy={cache === 'refreshing'}
          data-aeon-part="holdings"
          data-aeon-state={stateToAttr(cache)}
        >
          <h3 className="collect-section-title">BNT assets without an issuer</h3>
          <TokenShelf assets={ungrouped} actions={actions} view={view} />
        </section>
      ) : null}
      {open ? <BntSendForm key={open.assetId} asset={open} onClose={() => send({ type: 'CLOSE' })} /> : null}
    </div>
  )
}

function BntSendForm({ asset, onClose }: { asset: BntAssetSummary; onClose: () => void }) {
  const action = useAsyncAction<'send' | 'burn'>()
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState(asset.kind === 'item' ? '1' : '')
  const amountPad = useAmountPad()
  const units = asset.kind === 'item' ? '1' : parseTokenAmount(amount, asset.dec ?? 0)
  const overBalance = units !== null && BigInt(units) > movableOf(asset)
  const burnable = units !== null && !overBalance
  const ready = recipient.trim().length > 0 && burnable
  const supply = bntSupplyLabel(asset)

  const submit = async () => {
    if (!units) return
    const to = recipient.trim()
    const what = asset.kind === 'item' ? label(asset) : `${formatTokenAmount(units, asset.dec ?? 0)} ${label(asset)}`
    const done: { delivered?: boolean } = {}
    const outcome = await action.run(
      'send',
      async () => {
        const identityKey = IDENTITY_KEY.test(to) ? to.toLowerCase() : (await resolvePinnedHandle(to)).identityKey
        done.delivered = (await transferBntAsset({ assetId: asset.assetId, recipient: identityKey, amount: units })).delivered
      },
      {
        confirm: {
          title: `Send ${what}?`,
          body: `${what} goes to ${to}. The proof travels with it, so their wallet checks it without an indexer.`,
          confirmLabel: 'Send',
        },
      },
    )
    if (!outcome.ok) {
      if (outcome.error) {
        playWalletSound('error')
        toastError('BNT send failed', outcome.error)
      }
      return
    }
    playWalletSound('soft')
    toastSuccess(`Sent ${what}`, done.delivered === false ? 'Their inbox was unreachable; the wallet keeps retrying.' : `Delivered to ${to}.`)
    onClose()
  }

  const burn = async () => {
    if (!units) return
    const what = asset.kind === 'item' ? label(asset) : `${formatTokenAmount(units, asset.dec ?? 0)} ${label(asset)}`
    const refused = await preflightBntBurn({ assetId: asset.assetId, amount: units }).then(() => null, asyncActionError)
    if (refused) {
      playWalletSound('error')
      toastError('BNT burn refused', refused)
      return
    }
    const outcome = await action.run(
      'burn',
      async () => {
        await burnBntAsset({ assetId: asset.assetId, amount: units })
      },
      {
        confirm: {
          title: `Burn ${what}?`,
          body: `${what} goes to a key nobody holds and can never move again. This cannot be undone.`,
          confirmLabel: 'Burn',
          danger: true,
        },
      },
    )
    if (!outcome.ok) {
      if (outcome.error) {
        playWalletSound('error')
        toastError('BNT burn failed', outcome.error)
      }
      return
    }
    playWalletSound('soft')
    toastSuccess(`Burned ${what}`, 'It can never move again.')
    onClose()
  }

  return (
    <form
      className="settings-form settings-form-compact"
      data-aeon-part="send"
      data-aeon-state={action.stateAttr}
      aria-label={`Send ${label(asset)}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !action.busy) void submit()
      }}
    >
      <h3 className="collect-section-title">Send {label(asset)}</h3>
      {supply ? <p className="settings-row-desc" data-aeon-part="supply">{supply}</p> : null}
      <Field.Root className="field">
        <Field.Label htmlFor="bnt-send-recipient">To</Field.Label>
        <Field.Control
          id="bnt-send-recipient"
          value={recipient}
          disabled={action.busy}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="$handle or identity key"
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      </Field.Root>
      {asset.kind === 'token' ? (
        <Field.Root className="field">
          <Field.Label htmlFor="bnt-send-amount">Amount (you hold {amountOf(asset)})</Field.Label>
          <Field.Control
            id="bnt-send-amount"
            {...amountInputProps(amountPad)}
            value={amount}
            disabled={action.busy}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            autoComplete="off"
            aria-invalid={amount.trim() !== '' && (units === null || overBalance)}
          />
          {amountPad ? (
            <AmountPad label="Amount keypad" value={amount} onChange={setAmount} disabled={action.busy} />
          ) : null}
        </Field.Root>
      ) : null}
      <div className="actions">
        <Button.Root variant="ghost" className="btn btn-ghost" disabled={action.busy} onClick={onClose}>
          <Button.Label>Cancel</Button.Label>
        </Button.Root>
        <Button.Root
          variant="ghost"
          className="btn btn-ghost"
          data-aeon-part="burn"
          disabled={!burnable || action.busy}
          title={asset.kind === 'item' ? `Burn ${label(asset)}` : 'Burn the amount above'}
          onClick={() => void burn()}
        >
          <Button.Label>{action.running('burn') ? 'Burning…' : 'Burn'}</Button.Label>
        </Button.Root>
        <Button.Root variant="solid" type="submit" className="btn btn-primary" data-aeon-part="trigger" disabled={!ready || action.busy}>
          <Button.Label>{action.running('send') ? 'Sending…' : 'Send'}</Button.Label>
        </Button.Root>
      </div>
      <AsyncActionPrompt action={action} />
    </form>
  )
}
