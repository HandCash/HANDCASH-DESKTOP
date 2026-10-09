import { stateToAttr } from '@aeon-ui/core'
import { Prompt } from '@aeon-ui/react'
import { useMachine } from '@xstate/react'
import { useEffect, useRef, useState } from 'react'
import type { WalletProfile } from '../machines/appMachine'
import { walletAccountMenuMachine } from '../machines/walletAccountMenuMachine'
import { readTrustedBalance, writeTrustedBalance } from '../wallet/balanceSnapshot'
import { copyText } from '../wallet/clipboard'
import { claimedHandleForAccount, subscribeClaimedCloudHandle } from '../wallet/handleClaim'
import { formatHandCashHandle } from '../wallet/handleFormat'
import { subscribeIssuerIdentities } from '../wallet/issuerIdentities'
import { setNavSection } from '../wallet/navStore'
import { accountProfile, subscribePublicIdentities, type AccountProfile } from '../wallet/publicIdentities'
import { refreshAfterAccountSwitch } from '../wallet/recompose'
import { fetchBalanceSats, switchVaultAccount } from '../wallet/session'
import { playWalletSound } from '../wallet/soundService'
import { toastError, toastSuccess } from '../wallet/toast'
import { getWalletRuntime, runtimeIsCurrent } from '../wallet/walletRuntime'
import { vaultIdentityKey } from '../wallet/vaultMaster'
import {
  claimVaultAccount,
  releaseActiveVaultAccount,
  takeVaultAccount,
} from '../wallet/vaultAccountHolding'
import {
  ensureVaultAccounts,
  isHeldHere,
  readVaultAccounts,
  subscribeVaultAccounts,
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

type AccountRow = VaultAccount & {
  label: string
  handle: string | null
  profile: AccountProfile | null
  heldHere: boolean
}

const accountMenuMachine = walletAccountMenuMachine.provide({
  actions: { openProfile: () => setNavSection('identity') },
})

/** The open account, read through its runtime. */
function activeAccount() {
  return getWalletRuntime()?.instance ?? null
}

function masterIdentityKeyFromActive(): string | null {
  const master = activeAccount()?.vaultMaster
  return master ? vaultIdentityKey(master) : null
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
  const [snapshot, send, actor] = useMachine(accountMenuMachine)
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  /** Identity whose displacement was already acted on. */
  const displacedRef = useRef<string | null>(null)
  const open = !snapshot.matches('closed')
  const busy = !snapshot.matches('closed') && !snapshot.matches('open')
  const stateAttr = stateToAttr(snapshot.value)

  const refreshList = () => {
    const active = activeAccount()
    const masterIk = masterIdentityKeyFromActive() ?? profile.identityKey
    if (active) ensureVaultAccounts(active.vaultMaster)
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
          heldHere: isHeldHere(account),
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
    const offAccounts = subscribeVaultAccounts(refreshList)
    return () => {
      offPublic()
      offIssuers()
      offHandle()
      offAccounts()
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
    const active = activeAccount()
    if (!active) {
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
    await performSwitch(index)
  }

  /** Switch the runtime to `index`; the chart is already in `switching` (or `creating`). */
  const performSwitch = async (index: number, arrived = false): Promise<boolean> => {
    const active = activeAccount()
    if (!active) {
      send({ type: 'FAIL', error: 'Unlock the vault before switching wallets.' })
      return false
    }
    try {
      const next = await switchVaultAccount({
        vaultMaster: active.vaultMaster,
        handle: active.handle,
        chain: active.chain,
        mnemonic: active.mnemonic,
        accountIndex: index,
      })
      const runtime = getWalletRuntime()
      if (!runtime || runtime.instance !== next) {
        throw new Error('Selected wallet runtime was replaced')
      }
      // An arriving account takes the recompose fence before anything can spend.
      const arrival = arrived ? settleAfterSwitch({ arrived: true }) : null
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
      if (!runtimeIsCurrent(runtime)) return false
      writeTrustedBalance(next.identityKey, next.chain, balanceSats)
      onAccountSwitched(nextProfile, balanceSats)
      playWalletSound('soft')
      send({ type: 'SWITCHED' })
      if (!arrival) void settleAfterSwitch()
      return true
    } catch (error) {
      toastError('Switch wallet', messageOf(error))
      send({ type: 'FAIL', error: messageOf(error) })
      return false
    }
  }

  const settleAfterSwitch = (opts?: { arrived: true }) =>
    refreshAfterAccountSwitch(opts).catch((error) => {
      console.warn('[vault-account] post-switch refresh failed', messageOf(error))
    })

  const runCreate = async () => {
    if (!activeAccount()) {
      toastError('Accounts', 'Unlock the vault before creating a wallet.')
      return
    }
    send({ type: 'CREATE' })
    await performCreate()
  }

  /** Reserve a new account for this device and open it; the chart is in `creating`. */
  const performCreate = async () => {
    const active = activeAccount()
    if (!active) {
      send({ type: 'FAIL', error: 'Unlock the vault before creating a wallet.' })
      return
    }
    try {
      const store = await claimVaultAccount({ master: active.vaultMaster })
      const created = store.accounts.filter(isHeldHere).at(-1)
      if (!created) throw new Error('The new wallet was not saved')
      toastSuccess('Wallet created', created.name)
      if (await performSwitch(created.index)) send({ type: 'CREATED' })
    } catch (error) {
      toastError('Create wallet', messageOf(error))
      send({ type: 'FAIL', error: messageOf(error) })
    }
  }

  const nextHeldAccount = (exclude: number): number | null => {
    const active = activeAccount()
    if (!active) return null
    const store = readVaultAccounts(vaultIdentityKey(active.vaultMaster))
    return store.accounts.find((a) => a.index !== exclude && isHeldHere(a))?.index ?? null
  }

  /** Move an account another device holds onto this one. */
  const runTake = async (index: number, force: boolean) => {
    const active = activeAccount()
    if (!active) {
      toastError('Accounts', 'Unlock the vault before moving a wallet.')
      return
    }
    send(force ? { type: 'CONFIRM' } : { type: 'TAKE', accountIndex: index })
    try {
      const result = await takeVaultAccount({ master: active.vaultMaster, index, force })
      if (result.kind === 'held-elsewhere') {
        send({ type: 'HELD_ELSEWHERE' })
        return
      }
      if (result.kind === 'unavailable') {
        throw new Error(`HandCash could not move this wallet here: ${result.reason}.`)
      }
      send({ type: 'TAKEN' })
      await performSwitch(index, true)
    } catch (error) {
      toastError('Move wallet', messageOf(error))
      send({ type: 'FAIL', error: messageOf(error) })
    }
  }

  /** Release the active account for another device, then leave it. */
  const runRelease = async () => {
    const runtime = getWalletRuntime()
    if (!runtime) return
    const active = runtime.instance
    send({ type: 'CONFIRM' })
    try {
      await releaseActiveVaultAccount(runtime)
      const next = nextHeldAccount(active.accountIndex)
      toastSuccess('Ready to move', 'On your other device, open the wallet menu and choose Move here.')
      send({ type: 'RELEASED', nextAccountIndex: next })
      if (next != null) await performSwitch(next)
      else await performCreate()
    } catch (error) {
      toastError('Move wallet', messageOf(error))
      send({ type: 'FAIL', error: messageOf(error) })
    }
  }

  const leaveRef = useRef({ performSwitch, performCreate, nextHeldAccount })
  leaveRef.current = { performSwitch, performCreate, nextHeldAccount }

  // Another install took the active account: it no longer signs here, so leave it.
  useEffect(() => {
    const check = () => {
      const active = activeAccount()
      if (!active || displacedRef.current === active.identityKey) return
      const store = readVaultAccounts(vaultIdentityKey(active.vaultMaster))
      const account = store.accounts.find((a) => a.index === active.accountIndex)
      if (!account || isHeldHere(account)) return
      const { performSwitch: toAccount, performCreate: toNew, nextHeldAccount: next } = leaveRef.current
      const nextAccountIndex = next(active.accountIndex)
      if (!actor.getSnapshot().can({ type: 'DISPLACED', nextAccountIndex })) return
      displacedRef.current = active.identityKey
      toastError('Wallet moved', 'Another device now holds this wallet, so it no longer spends here.')
      send({ type: 'DISPLACED', nextAccountIndex })
      void (nextAccountIndex != null ? toAccount(nextAccountIndex) : toNew())
    }
    check()
    return subscribeVaultAccounts(check)
  }, [actor, send])

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
                      onClick={() =>
                        void (account.heldHere ? runSwitch(account.index) : runTake(account.index, false))
                      }
                    >
                      <span className="wallet-account-option-lead">
                        <ProfileAvatar profile={account.profile} label={name} />
                        <span className="wallet-account-option-copy">
                          <strong>{name}</strong>
                          <span>
                            {switching
                              ? 'Switching…'
                              : !account.heldHere
                                ? 'On another device · Move here'
                                : account.handle ?? (account.profile ? account.label : 'No public profile')}
                          </span>
                        </span>
                      </span>
                      {selected ? (
                        <CheckIcon size={17} className="wallet-account-option-check" />
                      ) : null}
                    </button>
                    {account.heldHere ? (
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
                    ) : null}
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

          <button
            type="button"
            className="wallet-account-create"
            data-aeon-part="release"
            disabled={busy}
            onClick={() => send({ type: 'RELEASE' })}
          >
            <span>Move {current?.profile?.name ?? current?.label ?? 'this wallet'} to another device</span>
          </button>

          {snapshot.context.error ? (
            <p className="wallet-account-error" role="alert">
              {snapshot.context.error}
            </p>
          ) : null}
        </section>
      ) : null}

      <Prompt.Root
        open={snapshot.matches('confirmTakeover') || snapshot.matches('confirmRelease')}
        status="pending"
        onOpenChange={(next) => {
          if (!next) send({ type: 'CANCEL' })
        }}
      >
        <Prompt.Portal>
          <Prompt.Backdrop className="permission-backdrop" />
          <Prompt.Positioner className="permission-positioner">
            <Prompt.Content
              className="panel modal permission-modal"
              data-aeon-part="holding-confirm"
              data-aeon-state={stateAttr}
            >
              {snapshot.matches('confirmTakeover') ? (
                <>
                  <Prompt.Title>Take this wallet from your other device?</Prompt.Title>
                  <Prompt.Effect>
                    Another device still holds it. Take it only if that device is lost or you have
                    stopped using this wallet there: two devices spending one wallet can pick the same
                    coins. The other device stops spending it when it next connects.
                  </Prompt.Effect>
                </>
              ) : (
                <>
                  <Prompt.Title>Move this wallet to another device?</Prompt.Title>
                  <Prompt.Effect>
                    HandCash backs up its history, then stops using it here. On your other device, open
                    the wallet menu and choose Move here.
                  </Prompt.Effect>
                </>
              )}
              <Prompt.Actions className="actions">
                <Prompt.Secondary
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => send({ type: 'CANCEL' })}
                >
                  Cancel
                </Prompt.Secondary>
                <Prompt.Primary
                  type="button"
                  className={snapshot.matches('confirmTakeover') ? 'btn btn-danger' : 'btn btn-primary'}
                  onClick={() => {
                    const index = snapshot.context.targetAccountIndex
                    if (snapshot.matches('confirmTakeover') && index != null) void runTake(index, true)
                    else void runRelease()
                  }}
                >
                  {snapshot.matches('confirmTakeover') ? 'Take over' : 'Move'}
                </Prompt.Primary>
              </Prompt.Actions>
            </Prompt.Content>
          </Prompt.Positioner>
        </Prompt.Portal>
      </Prompt.Root>
    </div>
  )
}
