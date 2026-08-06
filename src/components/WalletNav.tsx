import {
  startTransition,
  useEffect,
  useState,
  type ComponentType,
  type SVGProps,
} from 'react'
import { stateToAttr } from '@aeon-ui/core'
import type { WalletProfile } from '../machines/appMachine'
import type { ConnectedApp } from '../wallet/permissions'
import { appDisplayName, getPermissionScope } from '../wallet/appIdentity'
import { getFriendById } from '../wallet/friends'
import {
  clearNavChild,
  getNavState,
  openAppDetails,
  openCollectableDetails,
  openNavChild,
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
import { SendCollectablePanel } from './SendCollectablePanel'
import { TransactionsPanel } from './RecentActivity'
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
import { HistoryBackupPanel } from './HistoryBackupPanel'
import { TrustholderBackupPanel } from './TrustholderBackupPanel'
import { LogViewerPanel } from './LogViewerPanel'
import { AboutHandCashPanel } from './AboutHandCashPanel'
import { WipeWalletPanel } from './WipeWalletPanel'
import { NavBreadcrumb } from './NavBreadcrumb'
import { getCollectable } from '../wallet/collectables'
import {
  ActivityIcon,
  AppsIcon,
  CollectablesIcon,
  FriendsIcon,
  IdentityIcon,
  SettingsIcon,
} from './icons'
import { playWalletSound } from '../wallet/soundService'

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
  { value: 'apps', label: 'Apps', shortLabel: 'Apps', Icon: AppsIcon },
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

  useEffect(() => subscribeNav(setNav), [])

  useEffect(() => {
    const child = nav.child
    if (!child || (child.type !== 'collectable' && child.type !== 'send-collectable')) {
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
    if (child.type === 'setting') return [root, { label: settingLabel(child.settingId) }]
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
    return [root, { label: 'Payment' }]
  })()

  const selectSection = (next: NavSection) => {
    playWalletSound('soft')
    // Panel trees stay mounted (see below). startTransition still lets the tap
    // highlight update before any remaining layout work from the section swap.
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
              {child.type === 'send-collectable' && (
                <SendCollectablePanel
                  outpoint={child.outpoint}
                  chain={profile.chain}
                  onSent={onSent}
                  onFail={onFail}
                />
              )}
              {child.type === 'setting' && child.settingId === 'change-password' && (
                <ChangePasswordPanel />
              )}
              {child.type === 'setting' &&
                (child.settingId === 'backup' ||
                  child.settingId === 'backup-phrase' ||
                  child.settingId === 'split-backup') && <WalletBackupPanel />}
              {child.type === 'setting' && child.settingId === 'device-handoff' && (
                <DeviceHandoffPanel />
              )}
              {child.type === 'setting' && child.settingId === 'history-backup' && (
                <HistoryBackupPanel />
              )}
              {child.type === 'setting' && child.settingId === 'trustholder-backup' && (
                <TrustholderBackupPanel />
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
          ) : (
            <div className="wallet-nav-panel">
              {/*
                Keep every root section mounted. Rapid tab taps used to remount
                whole panel trees (QR, settings status, collectable grid) on the
                main thread and freeze the UI for seconds — see stall logs.
                `hidden` is display:none, so off-section work stays inert.
              */}
              <div hidden={nav.section !== 'activity'}>
                <TransactionsPanel chain={profile.chain} />
              </div>
              <div hidden={nav.section !== 'apps'}>
                <ConnectedAppsPanel apps={apps} />
              </div>
              <div hidden={nav.section !== 'collectables'}>
                <InventoryPanel />
              </div>
              <div hidden={nav.section !== 'friends'}>
                <FriendsPanel chain={profile.chain} />
              </div>
              <div hidden={nav.section !== 'identity'}>
                <IdentityPanel profile={profile} />
              </div>
              <div hidden={nav.section !== 'settings'}>
                <SettingsPanel />
              </div>
            </div>
          )}
        </div>

        <div className="wallet-nav-bar" role="tablist" aria-label="Wallet sections">
          <div className="wallet-nav-bar-track">
            {SECTIONS.map(({ value, label, shortLabel, Icon }) => {
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
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
