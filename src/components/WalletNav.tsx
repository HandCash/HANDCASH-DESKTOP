import { useState, type ComponentType, type SVGProps } from 'react'
import { Tabs } from '@aeon-ui/react'
import { stateToAttr } from '@aeon-ui/core'
import type { WalletProfile } from '../machines/appMachine'
import type { ConnectedApp } from '../wallet/permissions'
import { ConnectedAppsPanel } from './ConnectedAppsPanel'
import { FriendsPanel } from './FriendsPanel'
import { IdentityPanel } from './IdentityPanel'
import { TransactionsPanel } from './RecentActivity'
import {
  AppsIcon,
  FriendsIcon,
  IdentityIcon,
  InventoryIcon,
  TransactionsIcon,
} from './icons'

type Section = 'apps' | 'payments' | 'inventory' | 'friends' | 'identity'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

type Props = {
  profile: WalletProfile
  apps: ConnectedApp[]
  onRevoke: (origin: string) => void
}

const SECTIONS: {
  value: Section
  label: string
  Icon: ComponentType<IconProps>
}[] = [
  { value: 'apps', label: 'Apps', Icon: AppsIcon },
  { value: 'payments', label: 'Payments', Icon: TransactionsIcon },
  { value: 'inventory', label: 'Inventory', Icon: InventoryIcon },
  { value: 'friends', label: 'Friends', Icon: FriendsIcon },
  { value: 'identity', label: 'Identity', Icon: IdentityIcon },
]

export function WalletNav({ profile, apps, onRevoke }: Props) {
  const [section, setSection] = useState<Section>('apps')

  return (
    <section
      className="wallet-nav-shell panel"
      data-aeon-scope="wallet-nav"
      data-aeon-state={stateToAttr(section)}
    >
      <Tabs.Root
        className="wallet-nav"
        defaultValue="apps"
        onValueChange={(value) => {
          if (SECTIONS.some((s) => s.value === value)) {
            setSection(value as Section)
          }
        }}
      >
        <div className="wallet-nav-stage">
          <Tabs.Content value="apps" className="wallet-nav-panel">
            <ConnectedAppsPanel apps={apps} onRevoke={onRevoke} />
          </Tabs.Content>
          <Tabs.Content value="payments" className="wallet-nav-panel">
            <TransactionsPanel chain={profile.chain} />
          </Tabs.Content>
          <Tabs.Content value="inventory" className="wallet-nav-panel">
            <div className="nav-section-body">
              <div className="connected-panel-head">
                <h2>Inventory</h2>
              </div>
              <p className="connected-empty-line">No items yet</p>
            </div>
          </Tabs.Content>
          <Tabs.Content value="friends" className="wallet-nav-panel">
            <FriendsPanel chain={profile.chain} />
          </Tabs.Content>
          <Tabs.Content value="identity" className="wallet-nav-panel">
            <IdentityPanel profile={profile} />
          </Tabs.Content>
        </div>

        <Tabs.List className="wallet-nav-bar">
          {SECTIONS.map(({ value, label, Icon }) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className="wallet-nav-tab"
              aria-label={label}
              title={label}
            >
              <Icon size={18} />
              <span className="wallet-nav-tab-label">{label}</span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>
    </section>
  )
}
