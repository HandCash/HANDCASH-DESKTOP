import { useEffect, useMemo, useState } from 'react'
import { useMachine } from '@xstate/react'
import { stateToAttr } from '@aeon-ui/core'
import { sendMachine } from '../machines/sendMachine'
import { qrRevealMachine } from '../machines/qrRevealMachine'
import { P2PKH } from '@bsv/sdk'
import {
  getActiveWallet,
  fetchBalanceSats,
  formatBsv,
} from '../wallet/session'
import { syncLegacyFunds } from '../wallet/syncFunds'
import {
  formatUsdFromSats,
  getCachedUsdPerBsv,
  refreshUsdPerBsv,
  subscribeUsdRate,
} from '../wallet/fx'
import {
  clearAppActivity,
  recordAppActivity,
  WALLET_ACTIVITY_ORIGIN,
} from '../wallet/appActivity'
import {
  addressFromIdentityKey,
  listFriends,
  searchFriends,
  subscribeFriends,
  type Friend,
} from '../wallet/friends'
import type { WalletProfile } from '../machines/appMachine'
import { QrDialog } from './QrDialog'
import { ModalPortal } from './ModalPortal'
import { SendIcon, ReceiveIcon, LockIcon, RefreshIcon } from './icons'
import {
  listConnectedApps,
  revokeOrigin,
  subscribeConnectedApps,
  type ConnectedApp,
} from '../wallet/permissions'
import { WhatIsBsvPanel } from './WhatIsBsvPanel'
import { WalletNav } from './WalletNav'
import { RecentActivityPanel } from './RecentActivity'

type Props = {
  profile: WalletProfile
  balanceSats: number
  error: string | null
  sending: boolean
  onOpenSend: () => void
  onCloseSend: () => void
  onSent: (balanceSats: number) => void
  onRefreshBalance: (balanceSats: number) => void
  onLock: () => void
  onFail: (error: string) => void
}

export function Dashboard({
  profile,
  balanceSats,
  error,
  sending,
  onOpenSend,
  onCloseSend,
  onSent,
  onRefreshBalance,
  onLock,
  onFail,
}: Props) {
  const [sendSnap, send] = useMachine(sendMachine)
  const [qrSnap, qrSend] = useMachine(qrRevealMachine)
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>(() => listConnectedApps())
  const [friends, setFriends] = useState<Friend[]>(() => listFriends())
  const [recipientQuery, setRecipientQuery] = useState('')
  const [showFriendMatches, setShowFriendMatches] = useState(false)
  const [usdPerBsv, setUsdPerBsv] = useState<number | null>(() => getCachedUsdPerBsv())
  const [refreshing, setRefreshing] = useState(false)
  const [balancePrimary, setBalancePrimary] = useState<'usd' | 'bsv'>('usd')
  const sendState = stateToAttr(sendSnap.value)

  useEffect(() => subscribeConnectedApps(setConnectedApps), [])
  useEffect(() => subscribeFriends(setFriends), [])
  useEffect(() => subscribeUsdRate(setUsdPerBsv), [])

  useEffect(() => {
    if (!sending) {
      setRecipientQuery('')
      setShowFriendMatches(false)
    }
  }, [sending])

  const friendMatches = useMemo(
    () => searchFriends(recipientQuery, friends).slice(0, 8),
    [recipientQuery, friends],
  )

  const selectFriend = (friend: Friend) => {
    try {
      const address = addressFromIdentityKey(friend.identityKey, profile.chain)
      setRecipientQuery(friend.label)
      setShowFriendMatches(false)
      send({ type: 'EDIT', to: address, friendLabel: friend.label })
    } catch (err) {
      onFail(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void refreshUsdPerBsv()
    const id = window.setInterval(() => {
      void refreshUsdPerBsv()
    }, 5 * 60_000)
    return () => window.clearInterval(id)
  }, [])

  const usdLabel = formatUsdFromSats(balanceSats, usdPerBsv)

  const showAddressQr = () => {
    qrSend({ type: 'SHOW', payload: { label: 'Receive', value: profile.address } })
  }

  const refreshWallet = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await refreshUsdPerBsv(true)
      const sats = await syncLegacyFunds()
      if (sats != null) onRefreshBalance(sats)
    } catch (err) {
      onFail(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    const sync = async () => {
      const sats = await syncLegacyFunds()
      if (!cancelled && sats != null) onRefreshBalance(sats)
    }

    void sync()
    const id = window.setInterval(() => {
      void sync()
    }, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.address])

  const confirmSend = async () => {
    send({ type: 'CONFIRM' })
    const active = getActiveWallet()
    if (!active) {
      send({ type: 'FAIL', error: 'Wallet locked' })
      onFail('Wallet locked')
      return
    }
    try {
      const satoshis = Math.round(Number(sendSnap.context.amount) * 1e8)
      if (!Number.isFinite(satoshis) || satoshis <= 0) throw new Error('Invalid amount')

      const lockingScript = new P2PKH().lock(sendSnap.context.to.trim()).toHex()
      const result = await active.wallet.createAction({
        description: `HandCash send to ${sendSnap.context.to}`,
        outputs: [
          {
            lockingScript,
            satoshis,
            outputDescription: 'Payment',
          },
        ],
      })

      const balance = await fetchBalanceSats(active.wallet)
      const txid =
        (result as { txid?: string })?.txid ?? `local-${Date.now().toString(16)}`
      const recipientNote = sendSnap.context.friendLabel
        ? `${sendSnap.context.friendLabel} (${sendSnap.context.to.trim()})`
        : sendSnap.context.to.trim()
      recordAppActivity({
        origin: WALLET_ACTIVITY_ORIGIN,
        kind: 'spent',
        sats: satoshis,
        method: 'send',
        note: `Sent to ${recipientNote}`,
        txid,
      })
      send({ type: 'SUCCESS', txid })
      onSent(balance)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      send({ type: 'FAIL', error: message })
      onFail(message)
    }
  }

  return (
    <section className="dashboard" data-aeon-scope="dashboard" data-aeon-state={sending ? 'sending' : 'ready'}>
      <div className="dashboard-main">
        <div className="panel wallet-hero">
          <button
            type="button"
            className="refresh-btn wallet-refresh"
            aria-label="Refresh balance"
            title="Refresh"
            disabled={refreshing}
            data-spinning={refreshing ? true : undefined}
            onClick={() => void refreshWallet()}
          >
            <RefreshIcon size={16} />
          </button>
          <div className="wallet-hero-main">
            <button
              type="button"
              className="wallet-balance"
              data-aeon-part="balance"
              data-aeon-state={balancePrimary}
              aria-label={
                balancePrimary === 'usd'
                  ? 'Balance in USD. Click to show BSV first.'
                  : 'Balance in BSV. Click to show USD first.'
              }
              title="Click to swap currency"
              onClick={() => setBalancePrimary((u) => (u === 'usd' ? 'bsv' : 'usd'))}
            >
              {balancePrimary === 'usd' ? (
                <>
                  <span className="balance balance-primary balance-fiat">{usdLabel}</span>
                  <span className="balance-secondary balance-bsv">{formatBsv(balanceSats)}</span>
                </>
              ) : (
                <>
                  <span className="balance balance-primary balance-bsv">{formatBsv(balanceSats)}</span>
                  <span className="balance-secondary balance-fiat">{usdLabel}</span>
                </>
              )}
            </button>
            <div className="actions wallet-actions">
              <button className="btn btn-primary btn-icon" onClick={onOpenSend}>
                <SendIcon size={16} />
                Send
              </button>
              <button className="btn btn-ghost btn-icon" onClick={showAddressQr}>
                <ReceiveIcon size={16} />
                Receive
              </button>
              <button className="btn btn-ghost btn-icon" onClick={onLock}>
                <LockIcon size={16} />
                Lock
              </button>
            </div>
          </div>

          {error && (
            <p className="error" role="status" style={{ marginTop: 10 }}>
              {error}
            </p>
          )}
        </div>

        <WalletNav
          profile={profile}
          apps={connectedApps}
          onRevoke={(origin) => {
            revokeOrigin(origin)
            clearAppActivity(origin)
            setConnectedApps(listConnectedApps())
          }}
        />
      </div>

      <aside className="dashboard-side">
        <WhatIsBsvPanel />
        <RecentActivityPanel chain={profile.chain} />
      </aside>

      <QrDialog
        open={qrSnap.matches('open') && Boolean(qrSnap.context.payload)}
        label={qrSnap.context.payload?.label ?? ''}
        value={qrSnap.context.payload?.value ?? ''}
        onClose={() => qrSend({ type: 'HIDE' })}
      />

      {sending && (
        <ModalPortal>
          <div className="modal-backdrop" data-aeon-scope="dialog" data-aeon-state={sendState}>
            <div className="panel modal" data-aeon-part="content">
              <h2>Send BSV</h2>

              {sendSnap.matches('editing') && (
                <>
                  <div className="field friend-recipient-field">
                    <label htmlFor="to">To</label>
                    <input
                      id="to"
                      value={recipientQuery}
                      onChange={(e) => {
                        const value = e.target.value
                        setRecipientQuery(value)
                        setShowFriendMatches(true)
                        send({ type: 'EDIT', to: value.trim(), friendLabel: null })
                      }}
                      onFocus={() => setShowFriendMatches(true)}
                      onBlur={() => {
                        window.setTimeout(() => setShowFriendMatches(false), 120)
                      }}
                      placeholder="Search friends or paste address"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {sendSnap.context.friendLabel && (
                      <p className="friend-recipient-hint">
                        Sending to <strong>{sendSnap.context.friendLabel}</strong>
                      </p>
                    )}
                    {showFriendMatches && friendMatches.length > 0 && (
                      <ul className="friend-suggest-list" role="listbox">
                        {friendMatches.map((friend) => (
                          <li key={friend.id}>
                            <button
                              type="button"
                              className="friend-suggest-item"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => selectFriend(friend)}
                            >
                              <strong>{friend.label}</strong>
                              <span className="mono">{friend.identityKey.slice(0, 16)}…</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="amount">Amount (BSV)</label>
                    <input
                      id="amount"
                      value={sendSnap.context.amount}
                      onChange={(e) => send({ type: 'EDIT', amount: e.target.value })}
                      placeholder="0.01"
                    />
                  </div>
                  <p className="brand-sub">
                    Available {formatUsdFromSats(balanceSats, usdPerBsv)} · {formatBsv(balanceSats)}
                  </p>
                  <div className="actions">
                    <button className="btn btn-primary" onClick={() => send({ type: 'REVIEW' })}>
                      Review
                    </button>
                    <button className="btn btn-ghost" onClick={onCloseSend}>
                      Cancel
                    </button>
                  </div>
                </>
              )}

              {sendSnap.matches('confirming') && (
                <>
                  <p className="lede">
                    Send <strong>{sendSnap.context.amount} BSV</strong> to
                    {sendSnap.context.friendLabel ? (
                      <>
                        {' '}
                        <strong>{sendSnap.context.friendLabel}</strong>
                      </>
                    ) : null}
                  </p>
                  <p className="mono">{sendSnap.context.to}</p>
                  <div className="actions">
                    <button className="btn btn-primary" onClick={() => void confirmSend()}>
                      Confirm
                    </button>
                    <button className="btn btn-ghost" onClick={() => send({ type: 'BACK' })}>
                      Back
                    </button>
                  </div>
                </>
              )}

              {sendSnap.matches('broadcasting') && <p className="lede">Broadcasting…</p>}

              {sendSnap.matches('success') && (
                <>
                  <p className="lede">Payment submitted.</p>
                  <p className="mono">{sendSnap.context.txid}</p>
                  <div className="actions">
                    <button
                      className="btn btn-primary"
                      onClick={() => {
                        send({ type: 'RESET' })
                        onCloseSend()
                      }}
                    >
                      Done
                    </button>
                  </div>
                </>
              )}

              {sendSnap.matches('failure') && (
                <>
                  <p className="error">{sendSnap.context.error}</p>
                  <div className="actions">
                    <button className="btn btn-ghost" onClick={() => send({ type: 'BACK' })}>
                      Edit
                    </button>
                    <button className="btn btn-ghost" onClick={onCloseSend}>
                      Close
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </ModalPortal>
      )}
    </section>
  )
}
