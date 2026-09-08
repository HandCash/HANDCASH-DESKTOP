import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import type {
  WalletAction,
  WalletActionBarProps,
} from './WalletActionBar'

export type WalletDockActions = Omit<
  WalletActionBarProps,
  'placement' | 'className'
>

type RegisterDock = (
  owner: symbol,
  actions: WalletDockActions | null,
) => void

const WalletActionDockContext = createContext<RegisterDock | null>(null)

export function WalletActionDockProvider({
  register,
  children,
}: {
  register: RegisterDock
  children: ReactNode
}) {
  return (
    <WalletActionDockContext.Provider value={register}>
      {children}
    </WalletActionDockContext.Provider>
  )
}

function proxyAction(
  key: 'primary' | 'secondary' | 'tertiary',
  action: WalletAction,
  latest: MutableRefObject<WalletDockActions | null>,
): WalletAction {
  return {
    ...action,
    onClick: () => latest.current?.[key]?.onClick(),
  }
}

/**
 * Temporarily replaces the normal wallet navigation with contextual actions.
 * Callbacks are proxied through a ref so form edits do not churn the dock.
 */
export function useWalletActionDock(actions: WalletDockActions | null): void {
  const register = useContext(WalletActionDockContext)
  const owner = useRef(Symbol('wallet-action-dock'))
  const latest = useRef(actions)
  latest.current = actions

  const signature = actions
    ? JSON.stringify({
        ariaLabel: actions.ariaLabel,
        primary: [
          actions.primary.label,
          actions.primary.shortLabel,
          actions.primary.disabled,
          actions.primary.tone,
        ],
        secondary: actions.secondary
          ? [
              actions.secondary.label,
              actions.secondary.shortLabel,
              actions.secondary.disabled,
              actions.secondary.tone,
            ]
          : null,
        tertiary: actions.tertiary
          ? [
              actions.tertiary.label,
              actions.tertiary.shortLabel,
              actions.tertiary.disabled,
              actions.tertiary.tone,
            ]
          : null,
      })
    : ''

  useLayoutEffect(() => {
    if (!register || !actions) return
    register(owner.current, {
      ariaLabel: actions.ariaLabel,
      primary: proxyAction('primary', actions.primary, latest),
      secondary: actions.secondary
        ? proxyAction('secondary', actions.secondary, latest)
        : undefined,
      tertiary: actions.tertiary
        ? proxyAction('tertiary', actions.tertiary, latest)
        : undefined,
    })
    return () => register(owner.current, null)
    // Primitive signature intentionally controls dock re-registration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, signature])
}
