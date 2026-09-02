import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useState,
  type ComponentType,
  type SVGProps,
} from 'react'
import { stateToAttr } from '@aeon-ui/core'
import type { WalletProfile } from '../machines/appMachine'
import {
  resolvePermission,
  subscribePermissionRequests,
  type ConnectedApp,
  type PendingPrompt,
} from '../wallet/permissions'
import { appDisplayName, getPermissionScope } from '../wallet/appIdentity'
import { activityNavLabel, getActivityById } from '../wallet/appActivity'
import { getFriendById } from '../wallet/friends'
import { isMobileWalletPlatform } from '../wallet/isMobilePlatform'
import { setAutoPaySettings } from '../wallet/autoPay'
import {
  clearNavChild,
  getNavState,
  getSettingBackStack,
  openAppDetails,
  openCollectableDetails,
  openFungibleDetails,
  openMessagesInbox,
  openNavChild,
  popSettingTo,
  setNavSection,
  subscribeNav,
  type NavSection,
  type NavState,
  type NavChild,
} from '../wallet/navStore'
import { ConnectedAppsPanel } from './ConnectedAppsPanel'
import { FriendsPanel } from './FriendsPanel'
import { FriendDetailsPanel } from './FriendDetailsPanel'
import { AddFriendPanel } from './AddFriendPanel'
import { MessagesPanel } from './MessagesPanel'
import { IdentityPanel } from './IdentityPanel'
import { InventoryPanel } from './InventoryPanel'
import { CollectableDetailsPanel } from './CollectableDetailsPanel'
import { FungibleDetailsPanel } from './FungibleDetailsPanel'
import { SendCollectablePanel } from './SendCollectablePanel'
import { SendFungiblePanel } from './SendFungiblePanel'
import { BurnAssetPanel } from './BurnAssetPanel'
import { TransactionsPanel } from './RecentActivity'
import {
  PermissionRequestPanel,
  type PermissionDecisionApi,
} from './PermissionRequestPanel'
import { AppDetailsPanel } from './AppDetailsPanel'
import { PermissionDetailsPanel } from './PermissionDetailsPanel'
import { SendPanel } from './SendPanel'
import { ScanPanel } from './ScanPanel'
import { ReceivePanel } from './ReceivePanel'
import { isPhoneShell } from '../wallet/runtimePlatform'
import { PaymentDetailsPanel } from './PaymentDetailsPanel'
import { SettingsPanel, settingLabel } from './SettingsPanel'
import { WalletHealthPanel } from './settings/WalletHealthPanel'
import { IndexPacksSettingsPanel } from './settings/IndexPacksSettingsPanel'
import { StatechartsPanel } from './StatechartsPanel'
import { UnlockSettingsPanel } from './UnlockSettingsPanel'
import { WalletBackupPanel } from './WalletBackupPanel'
import { DeviceHandoffPanel } from './DeviceHandoffPanel'
import { ImportPhrasePanel } from './ImportPhrasePanel'
import { HistoryBackupPanel } from './HistoryBackupPanel'
import { LogViewerPanel } from './LogViewerPanel'
import { AboutHandCashPanel } from './AboutHandCashPanel'
import { WipeWalletPanel } from './WipeWalletPanel'
import { NavBreadcrumb } from './NavBreadcrumb'
import { getCachedCollectable, getCollectable } from '../wallet/collectables'
import { getFungible, getCachedFungibles } from '../wallet/fungibles'
import {
  ActivityIcon,
  AppsIcon,
  CheckIcon,
  CloseIcon,
  CollectablesIcon,
  FriendsIcon,
  IdentityIcon,
  SettingsIcon,
} from './icons'
import { playWalletSound } from '../wallet/soundService'
import { toastSuccess } from '../wallet/toast'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

type Props = {
  profile: WalletProfile
  apps: ConnectedApp[]
  onRevoke: (origin: string) => void
  onSent: (balanceSats: number) => void
  onFail: (error: string) => void
}

const SECTIONS: {
  value: NavSection
  label: string
  shortLabel: string
  Icon: ComponentType<IconProps>
}[] = [
  { value: 'activity', label: 'Activity', shortLabel: 'Activity', Icon: ActivityIcon },
  { value: 'apps', label: 'Connect', shortLabel: 'Connect', Icon: AppsIcon },
  { value: 'collectables', label: 'Collectables', shortLabel: 'Collect', Icon: CollectablesIcon },
  { value: 'friends', label: 'Friends', shortLabel: 'Friends', Icon: FriendsIcon },
  { value: 'identity', label: 'Identity', shortLabel: 'ID', Icon: IdentityIcon },
  { value: 'settings', label: 'Settings', shortLabel: 'Set', Icon: SettingsIcon },
]

function sectionLabel(section: NavSection): string {
  return SECTIONS.find((s) => s.value === section)?.label ?? section
}

function collectableChildOutpoint(child: NavChild | null): string | null {
  if (!child) return null
  if (
    child.type === 'collectable' ||
    child.type === 'send-collectable' ||
    child.type === 'burn-collectable'
  ) {
    return child.outpoint
  }
  return null
}

function childPanelKey(state: NavState): string {
  const child = state.child
  if (!child) return `${state.section}:`
  if ('outpoint' in child && typeof child.outpoint === 'string') {
    return `${state.section}:${child.type}:${child.outpoint}`
  }
  if ('tokenId' in child && typeof child.tokenId === 'string') {
    return `${state.section}:${child.type}:${child.tokenId}`
  }
  if ('entryId' in child && typeof child.entryId === 'string') {
    return `${state.section}:${child.type}:${child.entryId}`
  }
  if ('friendId' in child && typeof child.friendId === 'string') {
    return `${state.section}:${child.type}:${child.friendId}`
  }
  if ('origin' in child && typeof child.origin === 'string') {
    return `${state.section}:${child.type}:${child.origin}`
  }
  return `${state.section}:${child.type}`
}

const MemoInventoryPanel = memo(InventoryPanel)

export const WalletNav = memo(function WalletNav({
  profile,
  apps,
  onRevoke,
  onSent,
  onFail,
}: Props) {
  const [nav, setNav] = useState<NavState>(() => getNavState())
  const [optimisticSection, setOptimisticSection] = useState<NavSection | null>(null)
  const [collectableLabel, setCollectableLabel] = useState('Collectable')
  const [fungibleLabel, setFungibleLabel] = useState('Token')
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null)
  const [decisionApi, setDecisionApi] = useState<PermissionDecisionApi | null>(null)
  const mobileInlinePermission = isMobileWalletPlatform() && pendingPrompt != null
  /**
   * Light tabs stay mounted once visited — remounting Activity/Identity on every
   * tap was the 2.6s stall in the latest log. Collectables never stays mounted:
   * ordinal images are what exhaust native memory.
   */
  const [mountedLight, setMountedLight] = useState<Set<NavSection>>(() => {
    const initial = getNavState().section
    return initial === 'collectables' ? new Set() : new Set([initial])
  })

  useEffect(
    () =>
      subscribeNav((next) => {
        setNav((prev) => {
          const panelOnly =
            next.section === prev.section &&
            childPanelKey(next) !== childPanelKey(prev)
          if (panelOnly) return next
          startTransition(() => setNav(next))
          return prev
        })
      }),
    [],
  )
  useEffect(() => {
    setOptimisticSection(null)
  }, [nav.section, nav.child?.type])
  useEffect(() => {
    if (!isMobileWalletPlatform()) return
    return subscribePermissionRequests(setPendingPrompt)
  }, [])

  useEffect(() => {
    if (!mobileInlinePermission) return
    startTransition(() => {
      setNavSection('activity')
      clearNavChild()
    })
    setMountedLight((prev) => {
      if (prev.has('activity')) return prev
      const next = new Set(prev)
      next.add('activity')
      return next
    })
  }, [mobileInlinePermission, pendingPrompt?.id])

  const onPermissionAllow = useCallback(
    (autoPay?: { enabled: boolean; maxUsd: number; windowHours: number }) => {
      if (!pendingPrompt) return false
      if (!resolvePermission(pendingPrompt.id, 'allow')) return false
      if (autoPay) setAutoPaySettings(pendingPrompt.origin, autoPay)
      const name = appDisplayName(pendingPrompt.origin)
      playWalletSound('connect')
      if (pendingPrompt.kind === 'connect') {
        toastSuccess('Connected', `${name} can use your wallet`)
      } else {
        toastSuccess('Approved', pendingPrompt.title || name)
      }
      return true
    },
    [pendingPrompt],
  )

  const onPermissionDeny = useCallback(() => {
    if (!pendingPrompt) return false
    if (!resolvePermission(pendingPrompt.id, 'deny')) return false
    playWalletSound('deny')
    return true
  }, [pendingPrompt])

  const onDecisionApi = useCallback((api: PermissionDecisionApi | null) => {
    setDecisionApi(api)
  }, [])

  useEffect(() => {
    if (nav.section === 'collectables') return
    startTransition(() => {
      setMountedLight((prev) => {
        if (prev.has(nav.section)) return prev
        const next = new Set(prev)
        next.add(nav.section)
        return next
      })
    })
  }, [nav.section])

  useEffect(() => {
    const outpoint = collectableChildOutpoint(nav.child)
    if (!outpoint) return
    const cached = getCachedCollectable(outpoint)
    if (cached?.name) setCollectableLabel(cached.name)
    let cancelled = false
    void getCollectable(outpoint).then((item) => {
      if (!cancelled && item?.name) setCollectableLabel(item.name)
    })
    return () => {
      cancelled = true
    }
  }, [nav.child])

  useEffect(() => {
    const child = nav.child
    if (
      !child ||
      (child.type !== 'fungible' &&
        child.type !== 'send-fungible' &&
        child.type !== 'burn-fungible')
    ) {
      return
    }
    const cached =
      getFungible(child.tokenId) ??
      getCachedFungibles().find((t) => t.tokenId === child.tokenId)
    setFungibleLabel(cached?.sym || 'Token')
  }, [nav.child])

  const child = nav.child
  // Desktop hosts Scan in the BSV price column — keep the activity feed visible.
  const scanInSide = child?.type === 'scan' && !isPhoneShell()
  const stageChild = scanInSide ? null : child
  const aeonState = stageChild ? `${nav.section}.${stageChild.type}` : nav.section

  const crumbs = (() => {
    const root = {
      label: sectionLabel(nav.section),
      onClick: () => clearNavChild(),
    }
    if (!stageChild) return [{ label: root.label }]
    if (stageChild.type === 'app') {
      const app = apps.find((a) => a.origin === stageChild.origin)
      return [root, { label: app?.name || appDisplayName(stageChild.origin) }]
    }
    if (stageChild.type === 'permission') {
      const app = apps.find((a) => a.origin === stageChild.origin)
      const scope = getPermissionScope(stageChild.scopeId)
      return [
        root,
        {
          label: app?.name || appDisplayName(stageChild.origin),
          onClick: () => {
            const found = apps.find((a) => a.origin === stageChild.origin)
            if (found) openAppDetails(found)
            else openNavChild('apps', { type: 'app', origin: stageChild.origin })
          },
        },
        { label: scope?.label ?? 'Permission' },
      ]
    }
    if (stageChild.type === 'send') return [root, { label: 'Send' }]
    if (stageChild.type === 'scan') return [root, { label: 'Scan' }]
    if (stageChild.type === 'receive') return [root, { label: 'Receive' }]
    if (stageChild.type === 'add-friend') return [root, { label: 'Add friend' }]
    if (stageChild.type === 'setting') {
      const stack = getSettingBackStack()
      return [
        root,
        ...stack.map((id) => ({
          label: settingLabel(id),
          onClick: () => popSettingTo(id),
        })),
        { label: settingLabel(stageChild.settingId) },
      ]
    }
    if (stageChild.type === 'friend') {
      const friend = getFriendById(stageChild.friendId)
      return [root, { label: friend?.label || 'Friend' }]
    }
    if (stageChild.type === 'messages') {
      const friend = stageChild.friendId ? getFriendById(stageChild.friendId) : null
      const chatCrumb = {
        label: 'Chat',
        ...(friend ? { onClick: () => openMessagesInbox() } : {}),
      }
      return friend
        ? [root, chatCrumb, { label: friend.label }]
        : [root, chatCrumb]
    }
    if (stageChild.type === 'collectable') {
      return [root, { label: collectableLabel }]
    }
    if (stageChild.type === 'fungible') {
      return [root, { label: fungibleLabel }]
    }
    if (stageChild.type === 'send-collectable') {
      return [
        root,
        {
          label: collectableLabel,
          onClick: () => openCollectableDetails(stageChild.outpoint),
        },
        { label: 'Send' },
      ]
    }
    if (stageChild.type === 'send-fungible') {
      return [
        root,
        {
          label: fungibleLabel,
          onClick: () => openFungibleDetails(stageChild.tokenId),
        },
        { label: 'Send' },
      ]
    }
    if (stageChild.type === 'burn-collectable') {
      return [
        root,
        {
          label: collectableLabel,
          onClick: () => openCollectableDetails(stageChild.outpoint),
        },
        { label: 'Burn' },
      ]
    }
    if (stageChild.type === 'burn-fungible') {
      return [
        root,
        {
          label: fungibleLabel,
          onClick: () => openFungibleDetails(stageChild.tokenId),
        },
        { label: 'Burn' },
      ]
    }
    if (stageChild.type === 'payment') {
      const entry = getActivityById(stageChild.entryId)
      return [root, { label: entry ? activityNavLabel(entry) : 'Transaction' }]
    }
    return [root, { label: 'Transaction' }]
  })()

  const activeSection = optimisticSection ?? nav.section

  const selectSection = (next: NavSection) => {
    if (next === nav.section && !nav.child) return
    setOptimisticSection(next)
    queueMicrotask(() => playWalletSound('soft'))
    startTransition(() => {
      if (next !== nav.section) setNavSection(next)
      else clearNavChild()
    })
  }

  return (
    <section
      className="wallet-nav-shell panel"
      data-aeon-scope="wallet-nav"
      data-aeon-state={stateToAttr(aeonState)}
    >
      <div className="wallet-nav">
        <div className="wallet-nav-stage">
          {stageChild ? (
            <div className="wallet-nav-panel nav-child-stage">
              <NavBreadcrumb crumbs={crumbs} />
              <div className="nav-child-body">
              {stageChild.type === 'app' && (() => {
                const app = apps.find((a) => a.origin === stageChild.origin)
                if (!app) return <p className="connected-empty-line">App not found</p>
                return (
                  <AppDetailsPanel
                    app={app}
                    onRevoke={onRevoke}
                    onDone={() => clearNavChild()}
                  />
                )
              })()}
              {stageChild.type === 'permission' && (
                <PermissionDetailsPanel origin={stageChild.origin} scopeId={stageChild.scopeId} />
              )}
              {stageChild.type === 'send' && (
                <SendPanel
                  chain={profile.chain}
                  identityKey={profile.identityKey}
                  initialRecipient={stageChild.prefill}
                  onSent={onSent}
                  onFail={onFail}
                  onClose={() => clearNavChild()}
                />
              )}
              {stageChild.type === 'scan' && <ScanPanel placement="nav" />}
              {stageChild.type === 'receive' && (
                <ReceivePanel address={profile.address} identityKey={profile.identityKey} />
              )}
              {stageChild.type === 'payment' && (
                <PaymentDetailsPanel entryId={stageChild.entryId} chain={profile.chain} />
              )}
              {stageChild.type === 'friend' && (
                <FriendDetailsPanel friendId={stageChild.friendId} chain={profile.chain} />
              )}
              {stageChild.type === 'messages' && (
                <MessagesPanel
                  chain={profile.chain}
                  identityKey={profile.identityKey}
                  peerId={stageChild.friendId}
                  nestedInNav
                  onSent={onSent}
                />
              )}
              {stageChild.type === 'add-friend' && <AddFriendPanel />}
              {stageChild.type === 'collectable' && (
                <CollectableDetailsPanel outpoint={stageChild.outpoint} />
              )}
              {stageChild.type === 'fungible' && (
                <FungibleDetailsPanel tokenId={stageChild.tokenId} />
              )}
              {stageChild.type === 'send-collectable' && (
                <SendCollectablePanel
                  outpoint={stageChild.outpoint}
                  chain={profile.chain}
                  onSent={onSent}
                  onFail={onFail}
                />
              )}
              {stageChild.type === 'send-fungible' && (
                <SendFungiblePanel
                  tokenId={stageChild.tokenId}
                  chain={profile.chain}
                  onSent={onSent}
                  onFail={onFail}
                />
              )}
              {stageChild.type === 'burn-collectable' && (
                <BurnAssetPanel target={{ kind: 'collectable', outpoint: stageChild.outpoint }} />
              )}
              {stageChild.type === 'burn-fungible' && (
                <BurnAssetPanel target={{ kind: 'fungible', tokenId: stageChild.tokenId }} />
              )}
              {stageChild.type === 'setting' && stageChild.settingId === 'change-password' && (
                <UnlockSettingsPanel />
              )}
              {stageChild.type === 'setting' &&
                (stageChild.settingId === 'backup' ||
                  stageChild.settingId === 'backup-phrase' ||
                  stageChild.settingId === 'split-backup') && (
                <WalletBackupPanel />
              )}
              {stageChild.type === 'setting' && stageChild.settingId === 'device-handoff' && (
                <DeviceHandoffPanel />
              )}
              {stageChild.type === 'setting' && stageChild.settingId === 'import-phrase' && (
                <ImportPhrasePanel />
              )}
              {stageChild.type === 'setting' && stageChild.settingId === 'history-backup' && (
                <HistoryBackupPanel />
              )}
              {stageChild.type === 'setting' && stageChild.settingId === 'logs' && <LogViewerPanel />}
              {stageChild.type === 'setting' && stageChild.settingId === 'wallet-health' && (
                <WalletHealthPanel />
              )}
              {stageChild.type === 'setting' && stageChild.settingId === 'index-packs' && (
                <IndexPacksSettingsPanel />
              )}
              {stageChild.type === 'setting' && stageChild.settingId === 'wipe-wallet' && (
                <WipeWalletPanel />
              )}
              {stageChild.type === 'setting' && stageChild.settingId === 'about-handcash' && (
                <AboutHandCashPanel />
              )}
              {stageChild.type === 'setting' && stageChild.settingId === 'statecharts' && (
                <StatechartsPanel />
              )}
              </div>
            </div>
          ) : null}

          <div className="wallet-nav-panel" hidden={stageChild != null && !mobileInlinePermission}>
            {(mountedLight.has('activity') || mobileInlinePermission) && (
              <div
                className="wallet-nav-slot"
                hidden={nav.section !== 'activity' && !mobileInlinePermission}
              >
                {mobileInlinePermission && pendingPrompt ? (
                  <PermissionRequestPanel
                    pending={pendingPrompt}
                    onAllow={onPermissionAllow}
                    onDeny={onPermissionDeny}
                    onDecisionApi={onDecisionApi}
                  />
                ) : (
                  <TransactionsPanel chain={profile.chain} />
                )}
              </div>
            )}
            {mountedLight.has('apps') && (
              <div className="wallet-nav-slot" hidden={nav.section !== 'apps' || mobileInlinePermission}>
                <ConnectedAppsPanel apps={apps} />
              </div>
            )}
            {/* Unmount Collect to free ordinal images. Remount paints the last
                durable list (collectables.ts) — never an emptied cache. */}
            {nav.section === 'collectables' && !mobileInlinePermission && (
              <MemoInventoryPanel />
            )}
            {mountedLight.has('friends') && (
              <div
                className="wallet-nav-slot"
                hidden={nav.section !== 'friends' || mobileInlinePermission}
              >
                <FriendsPanel chain={profile.chain} />
              </div>
            )}
            {mountedLight.has('identity') && (
              <div
                className="wallet-nav-slot"
                hidden={nav.section !== 'identity' || mobileInlinePermission}
              >
                <IdentityPanel profile={profile} />
              </div>
            )}
            {mountedLight.has('settings') && (
              <div
                className="wallet-nav-slot"
                hidden={nav.section !== 'settings' || mobileInlinePermission}
              >
                <SettingsPanel />
              </div>
            )}
          </div>
        </div>

        <div
          className="wallet-nav-bar"
          role={mobileInlinePermission ? 'group' : 'tablist'}
          aria-label={mobileInlinePermission ? 'Permission decision' : 'Wallet sections'}
          data-permission={mobileInlinePermission ? '' : undefined}
        >
          <div className="wallet-nav-bar-track">
            {mobileInlinePermission ? (
              <>
                <button
                  type="button"
                  className="wallet-nav-tab wallet-nav-tab-deny"
                  aria-label={decisionApi?.denyLabel ?? 'Decline'}
                  title={decisionApi?.denyLabel ?? 'Decline'}
                  onClick={() => (decisionApi ? decisionApi.deny() : onPermissionDeny())}
                >
                  <CloseIcon size={18} />
                  <span className="wallet-nav-tab-label">
                    {decisionApi?.denyLabel ?? 'Decline'}
                  </span>
                  <span className="wallet-nav-tab-label-short">
                    {decisionApi?.denyLabel ?? 'Decline'}
                  </span>
                </button>
                <button
                  type="button"
                  className="wallet-nav-tab wallet-nav-tab-accept"
                  aria-label={decisionApi?.allowLabel ?? 'Accept'}
                  title={decisionApi?.allowLabel ?? 'Accept'}
                  data-selected=""
                  disabled={!decisionApi || decisionApi.allowDisabled}
                  onClick={() => decisionApi?.allow()}
                >
                  <CheckIcon size={18} />
                  <span className="wallet-nav-tab-label">
                    {decisionApi?.allowLabel ?? 'Accept'}
                  </span>
                  <span className="wallet-nav-tab-label-short">
                    {decisionApi?.allowLabel ?? 'Accept'}
                  </span>
                </button>
              </>
            ) : (
              SECTIONS.map(({ value, label, shortLabel, Icon }) => {
                const selected = activeSection === value
                return (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    className="wallet-nav-tab"
                    aria-label={label}
                    aria-selected={selected}
                    title={label}
                    data-selected={selected ? '' : undefined}
                    onClick={() => selectSection(value)}
                  >
                    <Icon size={18} />
                    <span className="wallet-nav-tab-label">{label}</span>
                    <span className="wallet-nav-tab-label-short">{shortLabel}</span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>
    </section>
  )
})
