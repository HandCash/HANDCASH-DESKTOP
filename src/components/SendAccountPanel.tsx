import { Button } from '@aeon-ui/react'
import { useCallback, useEffect, useState } from 'react'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { listSendableSubAccounts, sendSubAccountToIdentityKey } from '../wallet/accountSend'
import { claimVaultAccount } from '../wallet/vaultAccountHolding'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { getWalletRuntime, runtimeIsCurrent } from '../wallet/walletRuntime'
import { normalizeIdentityKey } from '../wallet/friends'
import type { VaultAccount } from '../wallet/vaultAccounts'
import { EmptyState } from './EmptyState'
import { SettingsNavRow } from './settings/SettingsNavRow'

type Props = {
  recipientIdentityKey: string
  recipientLabel: string
  onSent?: () => void
  onCancel?: () => void
}

type Phase = 'pick' | 'confirm'

/**
 * Send a held vault sub-account to a confirmed identity key. When none are
 * held here, shows an empty state with a create action — never a broken send.
 */
export function SendAccountPanel({
  recipientIdentityKey,
  recipientLabel,
  onSent,
  onCancel,
}: Props) {
  const recipient = normalizeIdentityKey(recipientIdentityKey)
  const [accounts, setAccounts] = useState<VaultAccount[]>([])
  const [phase, setPhase] = useState<Phase>('pick')
  const [picked, setPicked] = useState<VaultAccount | null>(null)
  const action = useAsyncAction<'create' | 'send'>()

  const refresh = useCallback(() => {
    const runtime = getWalletRuntime()
    if (!runtime || !runtimeIsCurrent(runtime)) {
      setAccounts([])
      return
    }
    setAccounts(
      listSendableSubAccounts(runtime.instance.vaultMaster, runtime.instance.accountIndex),
    )
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const createWallet = () => {
    void action.run('create', async () => {
      const runtime = getWalletRuntime()
      if (!runtime || !runtimeIsCurrent(runtime)) {
        throw new Error('Unlock the vault before creating a wallet.')
      }
      await claimVaultAccount({ master: runtime.instance.vaultMaster })
      playWalletSound('soft')
      toastSuccess('Wallet created', 'Pick it below to send.')
      refresh()
    }).then((outcome) => {
      if (!outcome.ok && outcome.error) {
        playWalletSound('error')
        toastError('Couldn’t create wallet', outcome.error)
      }
    })
  }

  const choose = (account: VaultAccount) => {
    setPicked(account)
    setPhase('confirm')
  }

  const confirmSend = () => {
    if (!picked) return
    void action
      .run('send', async () => {
        const runtime = getWalletRuntime()
        if (!runtime || !runtimeIsCurrent(runtime)) {
          throw new Error('Unlock the vault before sending a wallet.')
        }
        const result = await sendSubAccountToIdentityKey({
          master: runtime.instance.vaultMaster,
          accountIndex: picked.index,
          recipientIdentityKey: recipient,
          confirmedRecipientIdentityKey: recipient,
          recipientLabel,
          fromIdentityKey: runtime.instance.identityKey,
        })
        playWalletSound('success')
        toastSuccess('Wallet sent', `${result.name} is on the way to ${recipientLabel}.`)
        refresh()
        setPhase('pick')
        setPicked(null)
        onSent?.()
      })
      .then((outcome) => {
        if (!outcome.ok && outcome.error) {
          playWalletSound('error')
          toastError('Couldn’t send wallet', outcome.error)
        }
      })
  }

  if (phase === 'confirm' && picked) {
    return (
      <div className="send-account-panel" data-aeon-scope="send-account" data-aeon-part="confirm">
        <p className="settings-hint">
          Send <strong>{picked.name}</strong> to {recipientLabel}. They open it as their own wallet.
          Anyone with this vault’s recovery phrase can still derive that key — only send a wallet you
          made for them.
        </p>
        <div className="friend-copy-row">
          <div>
            <span className="field-static-label">Recipient key</span>
            <span className="mono wallet-detail-value" title={recipient}>
              {recipient}
            </span>
          </div>
        </div>
        <div className="actions friend-details-actions">
          <Button.Root
            variant="ghost"
            className="btn btn-ghost"
            disabled={action.busy}
            onClick={() => {
              setPhase('pick')
              setPicked(null)
              onCancel?.()
            }}
          >
            <Button.Label>Back</Button.Label>
          </Button.Root>
          <Button.Root
            variant="solid"
            className="btn btn-primary"
            disabled={action.busy}
            // Approval must not take focus (keyboard must never confirm by accident).
            autoFocus={false}
            onClick={confirmSend}
          >
            <Button.Label>{action.running('send') ? 'Sending…' : 'Send wallet'}</Button.Label>
          </Button.Root>
        </div>
      </div>
    )
  }

  if (accounts.length === 0) {
    return (
      <div className="send-account-panel" data-aeon-scope="send-account" data-aeon-part="empty">
        <EmptyState
          title="No wallets to send"
          body="Add a wallet first, or switch away from the one you want to send. Primary stays here."
          action={
            <Button.Root
              variant="solid"
              className="btn btn-primary"
              disabled={action.busy}
              onClick={createWallet}
            >
              <Button.Label>{action.running('create') ? 'Creating…' : 'Add wallet'}</Button.Label>
            </Button.Root>
          }
        />
      </div>
    )
  }

  return (
    <div className="send-account-panel" data-aeon-scope="send-account" data-aeon-part="pick">
      <p className="settings-hint">Pick a wallet to send to {recipientLabel}.</p>
      <ul className="settings-list" aria-label="Wallets to send">
        {accounts.map((account) => (
          <SettingsNavRow
            key={account.index}
            label={account.name}
            description={`${account.identityKey.slice(0, 16)}…`}
            onClick={() => {
              if (!action.busy) choose(account)
            }}
          />
        ))}
      </ul>
    </div>
  )
}
