import type { ReactNode } from 'react'
import { WalletActionBar } from './WalletActionBar'
import {
  useWalletActionDock,
  type WalletDockActions,
} from './WalletActionDock'

type Props = {
  scope: string
  state?: string
  actions: WalletDockActions
  placement?: 'nav' | 'inline'
  className?: string
  children: ReactNode
}

/**
 * Canonical wallet-request archetype.
 *
 * Request producers supply context and decisions; the wallet owns the panel,
 * scrolling, action ordering, and contextual bottom-dock behavior.
 */
export function WalletRequestTemplate({
  scope,
  state,
  actions,
  placement = 'nav',
  className = '',
  children,
}: Props) {
  useWalletActionDock(placement === 'nav' ? actions : null)

  return (
    <div
      className={`permission-request-panel ${
        placement === 'inline' ? 'permission-request-panel--column' : ''
      } ${className}`.trim()}
      data-aeon-scope={scope}
      data-aeon-state={state}
    >
      {placement === 'inline' ? (
        <div className="permission-request-scroll">{children}</div>
      ) : (
        children
      )}
      {placement === 'inline' ? (
        <WalletActionBar
          {...actions}
          className="connect-actions permission-request-actions"
        />
      ) : null}
    </div>
  )
}
