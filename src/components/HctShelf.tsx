import { startTransition, useEffect, useState } from 'react'
import { stateToAttr } from '@aeon-ui/core'
import { useMachine } from '@xstate/react'
import { fromPromise, type SnapshotFrom } from 'xstate'
import { hctHoldingsMachine } from '../machines/hctHoldingsMachine'
import { subscribeAppActivity } from '../features/activity'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { AsyncActionPrompt } from './AsyncActionPrompt'
import { FungibleTokenFace } from './FungibleTokenFace'
import { listHctAssets, transferHctAsset, type HctAssetSummary } from '../wallet/hct/wallet'
import { formatFungibleAmount, parseFungibleAmount } from '../wallet/token/types'
import { resolvePinnedHandle } from '../wallet/friends'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import type { CollectionView } from '../wallet/collectionView'

const IDENTITY_KEY = /^0[23][0-9a-f]{64}$/i

const holdingsMachine = hctHoldingsMachine.provide({
  actors: { load: fromPromise(async () => (await listHctAssets()).assets) },
})

type Holdings = {
  snapshot: SnapshotFrom<typeof hctHoldingsMachine>
  send: ReturnType<typeof useMachine<typeof holdingsMachine>>[1]
}

/** One holdings chart per Collectables view; any wallet activity (issue, send, receive) reloads it. */
export function useHctHoldings(): Holdings {
  const [snapshot, send] = useMachine(holdingsMachine)
  useEffect(
    () => subscribeAppActivity(() => startTransition(() => send({ type: 'REFRESH' }))),
    [send],
  )
  return { snapshot, send }
}

function label(asset: HctAssetSummary): string {
  return asset.sym || asset.name || `${asset.assetId.slice(0, 8)}…`
}

function amountOf(asset: HctAssetSummary): string {
  return formatFungibleAmount(asset.balance, asset.dec ?? 0)
}

/**
 * Open HCT (BRC-255) holdings inside Collectables: items beside 1Sat items,
 * tokens beside P2P-FT tokens. They move only through `transferHctAsset`.
 */
export function HctShelf({ holdings, view }: { holdings: Holdings; view: CollectionView }) {
  const { snapshot, send } = holdings
  const { assets, composing, error } = snapshot.context
  const tokens = assets.filter((a) => a.kind === 'token')
  const items = assets.filter((a) => a.kind === 'item')
  const open = composing ? assets.find((a) => a.assetId === composing) ?? null : null
  const failed = snapshot.matches('failed')

  if (assets.length === 0 && !failed) return null

  const shelf = (title: string, list: HctAssetSummary[]) =>
    list.length > 0 ? (
      <section className="collect-tokens-section" aria-label={title}>
        <h3 className="collect-section-title">{title}</h3>
        <ul className="token-strip" role="list" aria-label={title} data-aeon-part="token-strip" data-aeon-state={view}>
          {list.map((asset) => (
            <li
              key={asset.assetId}
              className="token-chip"
              data-aeon-part="token"
              data-aeon-state={asset.assetId === composing ? 'composing' : 'idle'}
            >
              <button
                type="button"
                className="token-chip-main"
                onClick={() => {
                  playWalletSound('soft')
                  send({ type: 'OPEN', assetId: asset.assetId })
                }}
                title={`${label(asset)} · HCT`}
                aria-label={`${label(asset)}, ${asset.kind === 'item' ? 'item' : amountOf(asset)}, HCT. Send`}
              >
                <span className="collectable-media collectable-media-sm collectable-media-token token-chip-face">
                  <FungibleTokenFace tokenId={asset.assetId} sym={label(asset)} size={view === 'grid' ? 72 : 56} />
                </span>
                <strong className="token-chip-sym" title={label(asset)}>
                  {label(asset)}
                </strong>
                <span className="fungible-card-amount token-chip-amount">
                  {asset.kind === 'item' ? asset.collection ? 'Collection item' : 'Item' : amountOf(asset)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    ) : null

  return (
    <div data-aeon-scope="hct-holdings" data-aeon-state={stateToAttr(snapshot.value)}>
      {failed ? (
        <div className="settings-row" data-aeon-part="failed">
          <span className="settings-row-desc">HCT holdings could not be read: {error}</span>
          <button type="button" className="btn btn-ghost" onClick={() => send({ type: 'REFRESH' })}>
            Retry
          </button>
        </div>
      ) : null}
      {shelf('HCT items', items)}
      {shelf('HCT tokens', tokens)}
      {open ? <HctSendForm key={open.assetId} asset={open} onClose={() => send({ type: 'CLOSE' })} /> : null}
    </div>
  )
}

function HctSendForm({ asset, onClose }: { asset: HctAssetSummary; onClose: () => void }) {
  const action = useAsyncAction<'send'>()
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState(asset.kind === 'item' ? '1' : '')
  const units = asset.kind === 'item' ? '1' : parseFungibleAmount(amount, asset.dec ?? 0)
  const overBalance = units !== null && BigInt(units) > BigInt(asset.balance || '0')
  const ready = recipient.trim().length > 0 && units !== null && !overBalance

  const submit = async () => {
    if (!units) return
    const to = recipient.trim()
    const what = asset.kind === 'item' ? label(asset) : `${formatFungibleAmount(units, asset.dec ?? 0)} ${label(asset)}`
    const done: { delivered?: boolean } = {}
    const outcome = await action.run(
      'send',
      async () => {
        const identityKey = IDENTITY_KEY.test(to) ? to.toLowerCase() : (await resolvePinnedHandle(to)).identityKey
        done.delivered = (await transferHctAsset({ assetId: asset.assetId, recipient: identityKey, amount: units })).delivered
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
        toastError('HCT send failed', outcome.error)
      }
      return
    }
    playWalletSound('soft')
    toastSuccess(`Sent ${what}`, done.delivered === false ? 'Their inbox was unreachable; the wallet keeps retrying.' : `Delivered to ${to}.`)
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
      <div className="field">
        <label htmlFor="hct-send-recipient">To</label>
        <input
          id="hct-send-recipient"
          value={recipient}
          disabled={action.busy}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="$handle or identity key"
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      </div>
      {asset.kind === 'token' ? (
        <div className="field">
          <label htmlFor="hct-send-amount">Amount (you hold {amountOf(asset)})</label>
          <input
            id="hct-send-amount"
            inputMode="decimal"
            value={amount}
            disabled={action.busy}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            autoComplete="off"
            aria-invalid={amount.trim() !== '' && (units === null || overBalance)}
          />
        </div>
      ) : null}
      <div className="actions">
        <button type="button" className="btn btn-ghost" disabled={action.busy} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" data-aeon-part="trigger" disabled={!ready || action.busy}>
          {action.running('send') ? 'Sending…' : 'Send'}
        </button>
      </div>
      <AsyncActionPrompt action={action} />
    </form>
  )
}
