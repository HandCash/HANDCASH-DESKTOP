import { useEffect, useRef, useState } from 'react'
import { PrivateKey } from '@bsv/sdk'
import type { WalletProfile } from '../machines/appMachine'
import { copyText } from '../wallet/clipboard'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import {
  fetchBalanceSats,
  getActiveWallet,
  switchVaultAccount,
} from '../wallet/session'
import { readTrustedBalance, writeTrustedBalance } from '../wallet/balanceSnapshot'
import { refreshFromChain } from '../wallet/chainIngest'
import {
  createVaultAccount,
  ensureVaultAccounts,
  readVaultAccounts,
  renameVaultAccount,
  type VaultAccount,
} from '../wallet/vaultAccounts'
import { AddIcon, CopyIcon, EditIcon, ExpandMoreIcon } from './icons'

type Props = {
  profile: WalletProfile
  identityLabel: string
  identityCopy: string
  onAccountSwitched: (profile: WalletProfile, balanceSats: number) => void
}

function masterIdentityKeyFromActive(): string | null {
  const active = getActiveWallet()
  if (!active?.masterRootKeyHex) return null
  return PrivateKey.fromHex(active.masterRootKeyHex).toPublicKey().toString()
}

export function WalletAccountMenu({
  profile,
  identityLabel,
  identityCopy,
  onAccountSwitched,
}: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [accounts, setAccounts] = useState<VaultAccount[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [renamingIndex, setRenamingIndex] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

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
    if (!open) return
    refreshList()
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setRenamingIndex(null)
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const runSwitch = async (index: number) => {
    const active = getActiveWallet()
    if (!active?.masterRootKeyHex) {
      toastError('Accounts', 'Unlock the vault before switching wallets.')
      return
    }
    if (index === active.accountIndex) {
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      const masterIk = PrivateKey.fromHex(active.masterRootKeyHex).toPublicKey().toString()
      const next = await switchVaultAccount({
        masterRootKeyHex: active.masterRootKeyHex,
        masterIdentityKey: masterIk,
        handle: active.handle,
        chain: active.chain,
        mnemonic: active.mnemonic,
        accountIndex: index,
      })
      const profile = {
        handle: next.handle,
        identityKey: next.identityKey,
        address: next.address,
        chain: next.chain,
      }
      // Instant paint from per-identity trusted snapshot — do not block the
      // hero on fetchBalance / sibling SetupClient / chain ingest.
      const trusted = readTrustedBalance(next.identityKey, next.chain) ?? 0
      playWalletSound('soft')
      onAccountSwitched(profile, trusted)
      setOpen(false)
      setBusy(false)
      // Background: local toolbox balance, then optional chain ingest.
      void (async () => {
        try {
          const balanceSats = await fetchBalanceSats(next.wallet)
          writeTrustedBalance(next.identityKey, next.chain, balanceSats)
          if (getActiveWallet()?.identityKey === next.identityKey) {
            onAccountSwitched(profile, balanceSats)
          }
        } catch (err) {
          console.warn(
            '[vault-account] local balance read failed — keeping trusted',
            err instanceof Error ? err.message : String(err),
          )
        }
        if (getActiveWallet()?.identityKey !== next.identityKey) return
        void refreshFromChain({ announceReceive: true }).catch((err) => {
          console.warn(
            '[vault-account] post-switch chain ingest failed',
            err instanceof Error ? err.message : String(err),
          )
        })
      })()
    } catch (err) {
      toastError('Switch wallet', err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const runCreate = async () => {
    const active = getActiveWallet()
    if (!active?.masterRootKeyHex) {
      toastError('Accounts', 'Unlock the vault before creating a wallet.')
      return
    }
    setBusy(true)
    try {
      const masterIk = PrivateKey.fromHex(active.masterRootKeyHex).toPublicKey().toString()
      const before = readVaultAccounts(masterIk)
      const store = createVaultAccount({
        masterRootKeyHex: active.masterRootKeyHex,
        masterIdentityKey: masterIk,
        name: `Wallet ${before.accounts.length}`,
      })
      const created = store.accounts[store.accounts.length - 1]!
      toastSuccess('Wallet created', created.name)
      await runSwitch(created.index)
    } catch (err) {
      toastError('Create wallet', err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const commitRename = (index: number) => {
    const masterIk = masterIdentityKeyFromActive() ?? profile.identityKey
    renameVaultAccount({
      masterIdentityKey: masterIk,
      index,
      name: renameValue,
    })
    setRenamingIndex(null)
    refreshList()
    playWalletSound('soft')
  }

  return (
    <div className="wallet-account-menu" ref={rootRef}>
      <div className="wallet-hero-identity-row">
        <button
          type="button"
          className="wallet-hero-identity"
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={busy}
          title="Switch wallet"
          onClick={() => {
            playWalletSound('soft')
            setOpen((v) => !v)
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
          onClick={() => {
            playWalletSound('soft')
            void copyText(identityCopy, { label: 'identity' })
          }}
        >
          <CopyIcon size={14} />
        </button>
      </div>
      {open ? (
        <div className="wallet-account-dropdown" role="listbox" aria-label="Wallets">
          <ul className="wallet-account-list">
            {accounts.map((acct) => {
              const selected = acct.index === activeIndex
              const isRoot = acct.index === 0
              const label =
                acct.name || (isRoot ? 'Primary' : `Wallet ${acct.index}`)
              return (
                <li key={acct.index}>
                  {renamingIndex === acct.index ? (
                    <form
                      className="wallet-account-rename"
                      onSubmit={(e) => {
                        e.preventDefault()
                        commitRename(acct.index)
                      }}
                    >
                      <input
                        autoFocus
                        className="wallet-account-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        aria-label="Wallet name"
                      />
                      <button type="submit" className="btn btn-ghost" disabled={busy}>
                        Save
                      </button>
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
                        onClick={() => void runSwitch(acct.index)}
                      >
                        <span className="wallet-account-option-name">
                          {label}
                          {isRoot ? (
                            <span className="wallet-account-option-tag">Root</span>
                          ) : null}
                        </span>
                        <span className="wallet-account-option-key mono">
                          {acct.identityKey.slice(0, 8)}…{acct.identityKey.slice(-6)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="wallet-account-rename-btn"
                        disabled={busy}
                        title="Rename"
                        aria-label="Rename wallet"
                        onClick={(e) => {
                          e.stopPropagation()
                          setRenamingIndex(acct.index)
                          setRenameValue(label)
                        }}
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
            <span>Create additional wallet</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
