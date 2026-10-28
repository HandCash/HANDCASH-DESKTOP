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
const TitlebarChildActiveContext = createContext(false)

/** Owns the desktop titlebar trailing slot + which section / depth is live. */
export function WalletNavChromeProvider({
  section,
  childActive = false,
  children,
}: {
  section: NavSection
  /** True while a nav child / browser covers the section root. */
  childActive?: boolean
  children: ReactNode
}) {
  const [node, setNode] = useState<HTMLElement | null>(null)
  return (
    <TitlebarSectionContext.Provider value={section}>
      <TitlebarChildActiveContext.Provider value={childActive}>
        <TitlebarActionsRegisterContext.Provider value={setNode}>
          <TitlebarActionsNodeContext.Provider value={node}>
            {children}
          </TitlebarActionsNodeContext.Provider>
        </TitlebarActionsRegisterContext.Provider>
      </TitlebarChildActiveContext.Provider>
    </TitlebarSectionContext.Provider>
  )
}

/** Portal mount for section chrome — sits inside `.wallet-nav-titlebar-actions`. */
export function TitlebarActionsSlot() {
  const register = useContext(TitlebarActionsRegisterContext)
  return <div className="wallet-nav-titlebar-actions-slot" ref={register} />
}

/**
 * Section head trailing controls. Desktop: portal into the titlebar actions
 * pill. Compact: stay in the panel head.
 *
 * `section` must match the live nav section — keep-alive panels stay mounted
 * under `[hidden]` and would otherwise stack filters in the titlebar.
 *
 * Child / subtext: only actions that belong to that subtext. Root
 * search/filter/view stay off unless `persistInChild` (and CSS still caps at 3).
 */
export function TitlebarActions({
  section,
  children,
  className,
  persistInChild = false,
}: {
  section: NavSection
  children: ReactNode
  className?: string
  /** Opt in when these controls map to the open subtext (not the section root). */
  persistInChild?: boolean
}) {
  const compact = useCompactShell()
  const live = useContext(TitlebarSectionContext)
  const childActive = useContext(TitlebarChildActiveContext)
  const slot = useContext(TitlebarActionsNodeContext)
  if (section !== live) return null
  // Send / Swap / … must not inherit Activity filters — only subtext-owned chrome.
  if (childActive && !persistInChild) return null

  const pillClass = [
    'wallet-nav-actions-pill',
    className,
    persistInChild ? 'wallet-nav-actions-pill--child' : null,
  ]
    .filter(Boolean)
    .join(' ')
  const pill = <div className={pillClass}>{children}</div>

  if (compact) return pill
  if (!slot) return null
  return createPortal(pill, slot)
}
