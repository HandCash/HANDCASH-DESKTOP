import { getActiveWallet } from '../wallet/session'

import { stateToAttr } from '@aeon-ui/core'
import { PrivateKey } from '@bsv/sdk'
import { useMachine } from '@xstate/react'
import { useEffect, useRef, useState } from 'react'
import type { WalletProfile } from '../machines/appMachine'
import { walletAccountMenuMachine } from '../machines/walletAccountMenuMachine'
import { readTrustedBalance, writeTrustedBalance } from '../wallet/balanceSnapshot'
import { refreshFromChain } from '../wallet/chainIngest'
import { copyText } from '../wallet/clipboard'
import { claimedHandleForAccount, subscribeClaimedCloudHandle } from '../wallet/handleClaim'
import { formatHandCashHandle } from '../wallet/handleFormat'
import { subscribeIssuerIdentities } from '../wallet/issuerIdentities'
import { setNavSection } from '../wallet/navStore'
import { accountProfile, subscribePublicIdentities, type AccountProfile } from '../wallet/publicIdentities'
import { fetchBalanceSats, switchVaultAccount } from '../wallet/session'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { getWalletRuntime, runtimeIsCurrent } from '../wallet/walletRuntime'
import {
  createVaultAccount,
  ensureVaultAccounts,
  readVaultAccounts,
  type VaultAccount,
} from '../wallet/vaultAccounts'
import { ProfileAvatar } from './ProfileAvatar'
import { AddIcon, CheckIcon, CopyIcon, EditIcon, ExpandMoreIcon } from './icons'

type Props = {
  profile: WalletProfile
  identityLabel: string
  identityCopy: string
  onAccountSwitchStarted: (profile: WalletProfile) => void
  onAccountSwitched: (profile: WalletProfile, balanceSats: number) => void
}

type AccountRow = VaultAccount & { label: string; handle: string | null; profile: AccountProfile | null }

const accountMenuMachine = walletAccountMenuMachine.provide({
  actions: { openProfile: () => setNavSection('identity') },
})

function masterIdentityKeyFromActive(): string | null {
  const root = getActiveWallet()?.masterRootKeyHex
  return root ? PrivateKey.fromHex(root).toPublicKey().toString() : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fallbackLabel(account: VaultAccount): string {
  return account.name || (account.index === 0 ? 'Primary' : `Wallet ${account.index}`)
}

export function WalletAccountMenu({
  profile,
  identityLabel,
  identityCopy,
  onAccountSwitchStarted,
  onAccountSwitched,
}: Props) {
  const [snapshot, send] = useMachine(accountMenuMachine)
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const open = !snapshot.matches('closed')
  const busy = snapshot.matches('switching') || snapshot.matches('creating')
  const stateAttr = stateToAttr(snapshot.value)

  const refreshList = () => {
    const active = getActiveWallet()
    const masterIk = masterIdentityKeyFromActive() ?? profile.identityKey
    if (active?.masterRootKeyHex) {
      ensureVaultAccounts(active.masterRootKeyHex, masterIk)
    }
    const store = readVaultAccounts(masterIk)
    setAccounts(
      store.accounts.map((account) => {
        const scope = { identityKey: account.identityKey, accountIndex: account.index, chain: profile.chain }
        const claimed = claimedHandleForAccount(scope)
        return {
          ...account,
          label: fallbackLabel(account),
          handle: claimed ? formatHandCashHandle(claimed.handle, null) || null : null,
          profile: accountProfile(scope),
        }
      }),
    )
    setActiveIndex(active?.accountIndex ?? store.activeIndex)
  }

  useEffect(() => {
    refreshList()
    const offPublic = subscribePublicIdentities(refreshList)
    const offIssuers = subscribeIssuerIdentities(refreshList)
    const offHandle = subscribeClaimedCloudHandle(refreshList)
    return () => {
      offPublic()
      offIssuers()
      offHandle()
    }
  }, [profile.identityKey, profile.chain])

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

  const runSwitch = async (index: number, then: 'stay' | 'profile' = 'stay') => {
    const active = getActiveWallet()
    if (!active?.masterRootKeyHex) {
      toastError('Accounts', 'Unlock the vault before switching wallets.')
      return
    }
    const isActive = index === active.accountIndex
    if (then === 'profile') {
      send({ type: 'EDIT_PROFILE', accountIndex: index, active: isActive })
      if (isActive) return
    } else if (isActive) {
      send({ type: 'CLOSE' })
      return
    } else {
      send({ type: 'CHOOSE', accountIndex: index })
    }
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
      const runtime = getWalletRuntime()
      if (!runtime || runtime.instance !== next) {
        throw new Error('Selected wallet runtime was replaced')
      }
      const nextProfile: WalletProfile = {
        handle: next.handle,
        identityKey: next.identityKey,
        address: next.address,
        chain: next.chain,
      }
      // Runtime, identity projection, and inventory must change in one beat.
      // The balance is explicitly pending until this wallet's Toolbox answers;
      // never leave the prior wallet's amount beside the new identity.
      onAccountSwitchStarted(nextProfile)
      let balanceSats = readTrustedBalance(next.identityKey, next.chain) ?? 0
      try {
        balanceSats = await fetchBalanceSats(next.wallet, {
          creditUnconfirmed: false,
        })
      } catch (error) {
        console.warn('[vault-account] local balance read failed', messageOf(error))
      }
      if (!runtimeIsCurrent(runtime)) return
      writeTrustedBalance(next.identityKey, next.chain, balanceSats)
      onAccountSwitched(nextProfile, balanceSats)
      playWalletSound('soft')
      send({ type: 'SWITCHED' })
      void refreshFromChain({ announceReceive: false }).catch((error) => {
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

  const current = accounts.find((account) => account.index === activeIndex)

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
          {current?.profile ? <ProfileAvatar profile={current.profile} label={current.profile.name} /> : null}
          <span>{current?.profile?.name ?? identityLabel}</span>
          <ExpandMoreIcon
            size={16}
            className={open ? 'wallet-account-caret is-open' : 'wallet-account-caret'}
          />
        </button>
        <button
          type="button"
          className="wallet-hero-identity-copy"
          title={`Copy ${identityCopy}`}
          aria-label="Copy pay address"
          onClick={() => void copyText(identityCopy, { label: 'pay address' })}
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
            </div>
            <span className="wallet-account-count">{accounts.length}</span>
          </header>

          <ul className="wallet-account-list" role="listbox" aria-label="Wallets">
            {accounts.map((account) => {
              const selected = account.index === activeIndex
              const switching =
                snapshot.matches('switching') &&
                snapshot.context.targetAccountIndex === account.index
              const name = account.profile?.name ?? account.label
              const editLabel = account.profile ? `Edit ${name} profile` : `Publish a profile for ${name}`
              return (
                <li key={account.index}>
                  <div className="wallet-account-row">
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={
                        selected ? 'wallet-account-option is-selected' : 'wallet-account-option'
                      }
                      disabled={busy}
                      onClick={() => void runSwitch(account.index)}
                    >
                      <span className="wallet-account-option-lead">
                        <ProfileAvatar profile={account.profile} label={name} />
                        <span className="wallet-account-option-copy">
                          <strong>{name}</strong>
                          <span>
                            {switching
                              ? 'Switching…'
                              : account.handle ?? (account.profile ? account.label : 'No public profile')}
                          </span>
                        </span>
                      </span>
                      {selected ? (
                        <CheckIcon size={17} className="wallet-account-option-check" />
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="wallet-account-profile-btn"
                      disabled={busy}
                      title={editLabel}
                      aria-label={editLabel}
                      onClick={() => void runSwitch(account.index, 'profile')}
                    >
                      <EditIcon size={16} />
                    </button>
                  </div>
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
