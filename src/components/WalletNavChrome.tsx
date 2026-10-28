import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useCompactShell } from '../wallet/isCompactShell'
import type { NavSection } from '../wallet/navStore'

const TitlebarActionsNodeContext = createContext<HTMLElement | null>(null)
const TitlebarActionsRegisterContext = createContext<
  ((node: HTMLElement | null) => void) | null
>(null)
const TitlebarSectionContext = createContext<NavSection>('activity')

/** Owns the desktop titlebar trailing slot + which section is live. */
export function WalletNavChromeProvider({
  section,
  children,
}: {
  section: NavSection
  children: ReactNode
}) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  return (
    <TitlebarSectionContext.Provider value={section}>
      <TitlebarActionsRegisterContext.Provider value={setNode}>
        <TitlebarActionsNodeContext.Provider value={node}>
          {children}
        </TitlebarActionsNodeContext.Provider>
      </TitlebarActionsRegisterContext.Provider>
    </TitlebarSectionContext.Provider>
  )
}

/** Callback ref target inside the desktop titlebar. */
export function TitlebarActionsSlot() {
  const register = useContext(TitlebarActionsRegisterContext)
  return <div className="wallet-nav-titlebar-actions" ref={register} />
}

/**
 * Section head trailing controls. Desktop: portal into the titlebar actions
 * pill. Compact: stay in the panel head.
 *
 * `section` must match the live nav section — keep-alive panels stay mounted
 * under `[hidden]` and would otherwise stack filters in the titlebar.
 */
export function TitlebarActions({
  section,
  children,
  className,
}: {
  section: NavSection
  children: ReactNode
  className?: string
}) {
  const compact = useCompactShell()
  const live = useContext(TitlebarSectionContext)
  const slot = useContext(TitlebarActionsNodeContext)
  if (section !== live) return null

  const pillClass = className
    ? `wallet-nav-actions-pill ${className}`
    : 'wallet-nav-actions-pill'
  const pill = <div className={pillClass}>{children}</div>

  if (compact) return pill
  if (!slot) return null
  return createPortal(pill, slot)
}
