import { stateToAttr } from '@aeon-ui/core'
import { PrivateKey } from '@bsv/sdk'
import { useMachine } from '@xstate/react'
import { useEffect, useRef, useState } from 'react'
import type { WalletProfile } from '../machines/appMachine'
import { walletAccountMenuMachine } from '../machines/walletAccountMenuMachine'
import { readTrustedBalance, writeTrustedBalance } from '../wallet/balanceSnapshot'
import { refreshFromChain } from '../wallet/chainIngest'
import { copyText } from '../wallet/clipboard'
import { fetchBalanceSats, getActiveWallet, switchVaultAccount } from '../wallet/session'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import {
  createVaultAccount,
  ensureVaultAccounts,
  readVaultAccounts,
  renameVaultAccount,
  type VaultAccount,
} from '../wallet/vaultAccounts'
import { AddIcon, CheckIcon, CopyIcon, EditIcon, ExpandMoreIcon } from './icons'

type Props = {
  profile: WalletProfile
  identityLabel: string
  identityCopy: string
  onAccountSwitched: (profile: WalletProfile, balanceSats: number) => void
}

function masterIdentityKeyFromActive(): string | null {
  const root = getActiveWallet()?.masterRootKeyHex
  return root ? PrivateKey.fromHex(root).toPublicKey().toString() : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function WalletAccountMenu({
  profile,
  identityLabel,
  identityCopy,
  onAccountSwitched,
}: Props) {
  const [snapshot, send] = useMachine(walletAccountMenuMachine)
  const [accounts, setAccounts] = useState<VaultAccount[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const open = !snapshot.matches('closed')
  const busy =
    snapshot.matches('switching') ||
    snapshot.matches('creating') ||
    snapshot.matches('renaming')
  const stateAttr = stateToAttr(snapshot.value)

  const refreshList = () => {
    const active = getActiveWallet()
    const masterIk = masterIdentityKeyFromActive() ?? profile.identityKey
    if (active?.masterRootKeyHex) {
      ensureVaultAccounts(active.masterRootKeyHex, masterIk)
    }
    const store = readVaultAccounts(masterIk)
    setAccounts(store.accounts)
    setActiveIndex(active?.accountIndex ?? store.activeIndex)
  }

  useEffect(() => {
    refreshList()
  }, [profile.identityKey])

  useEffect(() => {
    if (!open || busy) return
    refreshList()
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        send({ type: 'CLOSE' })
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') send({ type: 'CLOSE' })
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [busy, open, send])

  const runSwitch = async (index: number) => {
    const active = getActiveWallet()
    if (!active?.masterRootKeyHex) {
      toastError('Accounts', 'Unlock the vault before switching wallets.')
      return
    }
    if (index === active.accountIndex) {
      send({ type: 'CLOSE' })
      return
    }
    send({ type: 'CHOOSE', accountIndex: index })
    try {
      const masterIk = PrivateKey.fromHex(active.masterRootKeyHex)
        .toPublicKey()
        .toString()
      const next = await switchVaultAccount({
        masterRootKeyHex: active.masterRootKeyHex,
        masterIdentityKey: masterIk,
        handle: active.handle,
        chain: active.chain,
        mnemonic: active.mnemonic,
        accountIndex: index,
      })
      let balanceSats = readTrustedBalance(next.identityKey, next.chain) ?? 0
      try {
        balanceSats = await fetchBalanceSats(next.wallet, {
          creditUnconfirmed: false,
        })
        writeTrustedBalance(next.identityKey, next.chain, balanceSats)
      } catch (error) {
        console.warn('[vault-account] local balance read failed', messageOf(error))
      }
      onAccountSwitched(
        {
          handle: next.handle,
          identityKey: next.identityKey,
          address: next.address,
          chain: next.chain,
        },
        balanceSats,
      )
      playWalletSound('soft')
      send({ type: 'SWITCHED' })
      void refreshFromChain({ announceReceive: true }).catch((error) => {
        console.warn('[vault-account] post-switch chain ingest failed', messageOf(error))
      })
    } catch (error) {
      toastError('Switch wallet', messageOf(error))
      send({ type: 'FAIL', error: messageOf(error) })
    }
  }

  const runCreate = async () => {
    const active = getActiveWallet()
    if (!active?.masterRootKeyHex) {
      toastError('Accounts', 'Unlock the vault before creating a wallet.')
      return
    }
    send({ type: 'CREATE' })
    try {
      const masterIk = PrivateKey.fromHex(active.masterRootKeyHex)
        .toPublicKey()
        .toString()
      const before = readVaultAccounts(masterIk)
      const store = createVaultAccount({
        masterRootKeyHex: active.masterRootKeyHex,
        masterIdentityKey: masterIk,
        name: `Wallet ${before.accounts.length}`,
      })
      const created = store.accounts.at(-1)
      if (!created) throw new Error('The new wallet was not saved')
      toastSuccess('Wallet created', created.name)
      await runSwitch(created.index)
      send({ type: 'CREATED' })
    } catch (error) {
      toastError('Create wallet', messageOf(error))
      send({ type: 'FAIL', error: messageOf(error) })
    }
  }

  const commitRename = () => {
    const index = snapshot.context.targetAccountIndex
    const name = snapshot.context.draftName.trim()
    if (index == null || !name) return
    try {
      renameVaultAccount({
        masterIdentityKey: masterIdentityKeyFromActive() ?? profile.identityKey,
        index,
        name,
      })
      refreshList()
      playWalletSound('soft')
      send({ type: 'RENAMED' })
    } catch (error) {
      send({ type: 'FAIL', error: messageOf(error) })
    }
  }

  return (
    <div
      className="wallet-account-menu"
      data-aeon-scope="wallet-account-menu"
      data-aeon-state={stateAttr}
      ref={rootRef}
    >
      <div className="wallet-hero-identity-row">
        <button
          type="button"
          className="wallet-hero-identity"
          data-aeon-part="trigger"
          aria-controls="wallet-account-dropdown"
          aria-expanded={open}
          aria-haspopup="dialog"
          disabled={busy}
          title="Switch wallet"
          onClick={() => {
            playWalletSound('soft')
            send({ type: 'TOGGLE' })
          }}
        >
          <span>{identityLabel}</span>
          <ExpandMoreIcon
            size={16}
            className={open ? 'wallet-account-caret is-open' : 'wallet-account-caret'}
          />
        </button>
        <button
          type="button"
          className="wallet-hero-identity-copy"
          title={`Copy ${identityCopy}`}
          aria-label="Copy identity"
          onClick={() => void copyText(identityCopy, { label: 'identity' })}
        >
          <CopyIcon size={14} />
        </button>
      </div>

      {open ? (
        <section
          id="wallet-account-dropdown"
          className="wallet-account-dropdown"
          data-aeon-part="content"
          aria-label="Choose wallet"
        >
          <header className="wallet-account-heading">
            <div>
              <strong>Choose wallet</strong>
              <span>Balances and sync stay separate.</span>
            </div>
            <span className="wallet-account-count">{accounts.length}</span>
          </header>

          <ul className="wallet-account-list" role="listbox" aria-label="Wallets">
            {accounts.map((account) => {
              const selected = account.index === activeIndex
              const editing =
                snapshot.matches('renaming') &&
                snapshot.context.targetAccountIndex === account.index
              const switching =
                snapshot.matches('switching') &&
                snapshot.context.targetAccountIndex === account.index
              const label =
                account.name || (account.index === 0 ? 'Primary' : `Wallet ${account.index}`)
              return (
                <li key={account.index}>
                  {editing ? (
                    <form
                      className="wallet-account-rename"
                      data-aeon-part="form"
                      onSubmit={(event) => {
                        event.preventDefault()
                        commitRename()
                      }}
                    >
                      <label htmlFor={`wallet-name-${account.index}`}>Wallet name</label>
                      <input
                        id={`wallet-name-${account.index}`}
                        className="wallet-account-rename-input"
                        value={snapshot.context.draftName}
                        maxLength={40}
                        autoFocus
                        onChange={(event) =>
                          send({ type: 'EDIT_NAME', name: event.target.value })
                        }
                      />
                      <div className="wallet-account-rename-actions">
                        <button
                          type="submit"
                          className="btn btn-primary"
                          disabled={!snapshot.context.draftName.trim()}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => send({ type: 'CANCEL_RENAME' })}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="wallet-account-row">
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={
                          selected
                            ? 'wallet-account-option is-selected'
                            : 'wallet-account-option'
                        }
                        disabled={busy}
                        onClick={() => void runSwitch(account.index)}
                      >
                        <span className="wallet-account-option-copy">
                          <strong>
                            {label}
                            {account.index === 0 ? (
                              <span className="wallet-account-option-tag">Root</span>
                            ) : null}
                          </strong>
                          <span className="mono">
                            {switching
                              ? 'Switching…'
                              : `${account.identityKey.slice(0, 8)}…${account.identityKey.slice(-6)}`}
                          </span>
                        </span>
                        {selected ? (
                          <CheckIcon size={17} className="wallet-account-option-check" />
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="wallet-account-rename-btn"
                        disabled={busy}
                        title={`Rename ${label}`}
                        aria-label={`Rename ${label}`}
                        onClick={() =>
                          send({
                            type: 'RENAME',
                            accountIndex: account.index,
                            name: label,
                          })
                        }
                      >
                        <EditIcon size={16} />
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          <button
            type="button"
            className="wallet-account-create"
            disabled={busy}
            onClick={() => void runCreate()}
          >
            <AddIcon size={16} />
            <span>Add wallet</span>
          </button>

          {snapshot.context.error ? (
            <p className="wallet-account-error" role="alert">
              {snapshot.context.error}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
