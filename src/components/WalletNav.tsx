import { useEffect, useState, type ComponentType, type SVGProps } from 'react'
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
import { IdentityPanel } from './IdentityPanel'
import { InventoryPanel } from './InventoryPanel'
import { CollectableDetailsPanel } from './CollectableDetailsPanel'
import { SendCollectablePanel } from './SendCollectablePanel'
import { TransactionsPanel } from './RecentActivity'
import { AppDetailsPanel } from './AppDetailsPanel'
import { PermissionDetailsPanel } from './PermissionDetailsPanel'
import { SendPanel } from './SendPanel'
import { ReceivePanel } from './ReceivePanel'
import { PaymentDetailsPanel } from './PaymentDetailsPanel'
import { SettingsPanel, settingLabel } from './SettingsPanel'
import { ChangePasswordPanel } from './ChangePasswordPanel'
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
  Icon: ComponentType<IconProps>
}[] = [
  { value: 'activity', label: 'Activity', Icon: ActivityIcon },
  { value: 'apps', label: 'Apps', Icon: AppsIcon },
  { value: 'collectables', label: 'Collectables', Icon: CollectablesIcon },
  { value: 'friends', label: 'Friends', Icon: FriendsIcon },
  { value: 'identity', label: 'Identity', Icon: IdentityIcon },
  { value: 'settings', label: 'Settings', Icon: SettingsIcon },
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
    if (child.type === 'receive') return [root, { label: 'Receive' }]
    if (child.type === 'add-friend') return [root, { label: 'Add friend' }]
    if (child.type === 'setting') return [root, { label: settingLabel(child.settingId) }]
    if (child.type === 'friend') {
      const friend = getFriendById(child.friendId)
      return [root, { label: friend?.label || 'Friend' }]
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
    if (next !== nav.section) setNavSection(next)
    else clearNavChild()
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
                  onSent={onSent}
                  onFail={onFail}
                  onClose={() => clearNavChild()}
                />
              )}
              {child.type === 'receive' && <ReceivePanel value={profile.address} />}
              {child.type === 'payment' && (
                <PaymentDetailsPanel entryId={child.entryId} chain={profile.chain} />
              )}
              {child.type === 'friend' && (
                <FriendDetailsPanel friendId={child.friendId} chain={profile.chain} />
              )}
              {child.type === 'add-friend' && <AddFriendPanel />}
              {child.type === 'collectable' && (
                <CollectableDetailsPanel outpoint={child.outpoint} />
              )}
              {child.type === 'send-collectable' && (
                <SendCollectablePanel
                  outpoint={child.outpoint}
                  chain={profile.chain}
                  onFail={onFail}
                />
              )}
              {child.type === 'setting' && child.settingId === 'change-password' && (
                <ChangePasswordPanel />
              )}
            </div>
          ) : (
            <div className="wallet-nav-panel">
              {nav.section === 'activity' && <TransactionsPanel chain={profile.chain} />}
              {nav.section === 'apps' && <ConnectedAppsPanel apps={apps} />}
              {nav.section === 'collectables' && <InventoryPanel />}
              {nav.section === 'friends' && <FriendsPanel chain={profile.chain} />}
              {nav.section === 'identity' && <IdentityPanel profile={profile} />}
              {nav.section === 'settings' && <SettingsPanel />}
            </div>
          )}
        </div>

        <div className="wallet-nav-bar" role="tablist" aria-label="Wallet sections">
          <div className="wallet-nav-bar-track">
            {SECTIONS.map(({ value, label, Icon }) => {
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
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
