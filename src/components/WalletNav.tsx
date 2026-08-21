import {
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
import { activityDetailLabel, getActivityById } from '../wallet/appActivity'
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
  openNavChild,
  popSettingTo,
  setNavSection,
  subscribeNav,
  type NavSection,
  type NavState,
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
import { PaymentDetailsPanel } from './PaymentDetailsPanel'
import { SettingsPanel, settingLabel } from './SettingsPanel'
import { StatechartsPanel } from './StatechartsPanel'
import { ChangePasswordPanel } from './ChangePasswordPanel'
import { WalletBackupPanel } from './WalletBackupPanel'
import { DeviceHandoffPanel } from './DeviceHandoffPanel'
import { ImportPhrasePanel } from './ImportPhrasePanel'
import { HistoryBackupPanel } from './HistoryBackupPanel'
import { LogViewerPanel } from './LogViewerPanel'
import { AboutHandCashPanel } from './AboutHandCashPanel'
import { WipeWalletPanel } from './WipeWalletPanel'
import { NavBreadcrumb } from './NavBreadcrumb'
import { getCollectable } from '../wallet/collectables'
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
  balanceSats: number
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

export function WalletNav({
  profile,
  apps,
  balanceSats,
  onRevoke,
  onSent,
  onFail,
}: Props) {
  const [nav, setNav] = useState<NavState>(() => getNavState())
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

  useEffect(() => subscribeNav(setNav), [])
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
    setMountedLight((prev) => {
      if (prev.has(nav.section)) return prev
      const next = new Set(prev)
      next.add(nav.section)
      return next
    })
  }, [nav.section])

  useEffect(() => {
    const child = nav.child
    if (
      !child ||
      (child.type !== 'collectable' &&
        child.type !== 'send-collectable' &&
        child.type !== 'burn-collectable')
    ) {
      return
    }
    let cancelled = false
    void getCollectable(child.outpoint).then((item) => {
      if (!cancelled) setCollectableLabel(item?.name || 'Collectable')
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
  const aeonState = child ? `${nav.section}.${child.type}` : nav.section

  const crumbs = (() => {
    const root = {
      label: sectionLabel(nav.section),
      onClick: () => clearNavChild(),
    }
    if (!child) return [{ label: root.label }]
    if (child.type === 'app') {
      const app = apps.find((a) => a.origin === child.origin)
      return [root, { label: app?.name || appDisplayName(child.origin) }]
    }
    if (child.type === 'permission') {
      const app = apps.find((a) => a.origin === child.origin)
      const scope = getPermissionScope(child.scopeId)
      return [
        root,
        {
          label: app?.name || appDisplayName(child.origin),
          onClick: () => {
            const found = apps.find((a) => a.origin === child.origin)
            if (found) openAppDetails(found)
            else openNavChild('apps', { type: 'app', origin: child.origin })
          },
        },
        { label: scope?.label ?? 'Permission' },
      ]
    }
    if (child.type === 'send') return [root, { label: 'Send' }]
    if (child.type === 'scan') return [root, { label: 'Scan' }]
    if (child.type === 'receive') return [root, { label: 'Receive' }]
    if (child.type === 'add-friend') return [root, { label: 'Add friend' }]
    if (child.type === 'setting') {
      const stack = getSettingBackStack()
      return [
        root,
        ...stack.map((id) => ({
          label: settingLabel(id),
          onClick: () => popSettingTo(id),
        })),
        { label: settingLabel(child.settingId) },
      ]
    }
    if (child.type === 'friend') {
      const friend = getFriendById(child.friendId)
      return [root, { label: friend?.label || 'Friend' }]
    }
    if (child.type === 'messages') {
      const friend = getFriendById(child.friendId)
      return [root, { label: friend?.label || 'Message' }]
    }
    if (child.type === 'collectable') {
      return [root, { label: collectableLabel }]
    }
    if (child.type === 'fungible') {
      return [root, { label: fungibleLabel }]
    }
    if (child.type === 'send-collectable') {
      return [
        root,
        {
          label: collectableLabel,
          onClick: () => openCollectableDetails(child.outpoint),
        },
        { label: 'Send' },
      ]
    }
    if (child.type === 'send-fungible') {
      return [
        root,
        {
          label: fungibleLabel,
          onClick: () => openFungibleDetails(child.tokenId),
        },
        { label: 'Send' },
      ]
    }
    if (child.type === 'burn-collectable') {
      return [
        root,
        {
          label: collectableLabel,
          onClick: () => openCollectableDetails(child.outpoint),
        },
        { label: 'Burn' },
      ]
    }
    if (child.type === 'burn-fungible') {
      return [
        root,
        {
          label: fungibleLabel,
          onClick: () => openFungibleDetails(child.tokenId),
        },
        { label: 'Burn' },
      ]
    }
    if (child.type === 'payment') {
      const entry = getActivityById(child.entryId)
      return [root, { label: entry ? activityDetailLabel(entry) : 'Transaction' }]
    }
    return [root, { label: 'Transaction' }]
  })()

  const selectSection = (next: NavSection) => {
    if (next === nav.section && !nav.child) return
    playWalletSound('soft')
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
          {child ? (
            <div className="wallet-nav-panel nav-child-stage">
              <NavBreadcrumb crumbs={crumbs} />
              <div className="nav-child-body">
              {child.type === 'app' && (() => {
                const app = apps.find((a) => a.origin === child.origin)
                if (!app) return <p className="connected-empty-line">App not found</p>
                return (
                  <AppDetailsPanel
                    app={app}
                    onRevoke={onRevoke}
                    onDone={() => clearNavChild()}
                  />
                )
              })()}
              {child.type === 'permission' && (
                <PermissionDetailsPanel origin={child.origin} scopeId={child.scopeId} />
              )}
              {child.type === 'send' && (
                <SendPanel
                  chain={profile.chain}
                  balanceSats={balanceSats}
                  initialRecipient={child.prefill}
                  onSent={onSent}
                  onFail={onFail}
                  onClose={() => clearNavChild()}
                />
              )}
              {child.type === 'scan' && <ScanPanel />}
              {child.type === 'receive' && (
                <ReceivePanel address={profile.address} identityKey={profile.identityKey} />
              )}
              {child.type === 'payment' && (
                <PaymentDetailsPanel entryId={child.entryId} chain={profile.chain} />
              )}
              {child.type === 'friend' && (
                <FriendDetailsPanel friendId={child.friendId} chain={profile.chain} />
              )}
              {child.type === 'messages' && (
                <MessagesPanel
                  chain={profile.chain}
                  identityKey={profile.identityKey}
                  peerId={child.friendId}
                  onSent={onSent}
                />
              )}
              {child.type === 'add-friend' && <AddFriendPanel />}
              {child.type === 'collectable' && (
                <CollectableDetailsPanel outpoint={child.outpoint} />
              )}
              {child.type === 'fungible' && (
                <FungibleDetailsPanel tokenId={child.tokenId} />
              )}
              {child.type === 'send-collectable' && (
                <SendCollectablePanel
                  outpoint={child.outpoint}
                  chain={profile.chain}
                  onSent={onSent}
                  onFail={onFail}
                />
              )}
              {child.type === 'send-fungible' && (
                <SendFungiblePanel
                  tokenId={child.tokenId}
                  chain={profile.chain}
                  onSent={onSent}
                  onFail={onFail}
                />
              )}
              {child.type === 'burn-collectable' && (
                <BurnAssetPanel target={{ kind: 'collectable', outpoint: child.outpoint }} />
              )}
              {child.type === 'burn-fungible' && (
                <BurnAssetPanel target={{ kind: 'fungible', tokenId: child.tokenId }} />
              )}
              {child.type === 'setting' && child.settingId === 'change-password' && (
                <ChangePasswordPanel />
              )}
              {child.type === 'setting' &&
                (child.settingId === 'backup' ||
                  child.settingId === 'backup-phrase' ||
                  child.settingId === 'split-backup') && (
                <WalletBackupPanel />
              )}
              {child.type === 'setting' && child.settingId === 'device-handoff' && (
                <DeviceHandoffPanel />
              )}
              {child.type === 'setting' && child.settingId === 'import-phrase' && (
                <ImportPhrasePanel />
              )}
              {child.type === 'setting' && child.settingId === 'history-backup' && (
                <HistoryBackupPanel />
              )}
              {child.type === 'setting' && child.settingId === 'logs' && <LogViewerPanel />}
              {child.type === 'setting' && child.settingId === 'wipe-wallet' && (
                <WipeWalletPanel />
              )}
              {child.type === 'setting' && child.settingId === 'about-handcash' && (
                <AboutHandCashPanel />
              )}
              {child.type === 'setting' && child.settingId === 'statecharts' && (
                <StatechartsPanel />
              )}
              </div>
            </div>
          ) : null}

          <div className="wallet-nav-panel" hidden={child != null && !mobileInlinePermission}>
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
            {nav.section === 'collectables' && !mobileInlinePermission && <InventoryPanel />}
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
                const selected = nav.section === value
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
}
