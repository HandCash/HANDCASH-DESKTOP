import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import type { NavSection } from '../wallet/navStore'
import {
  NavBreadcrumbTrail,
  type NavCrumb,
} from './NavBreadcrumb'

type SectionBannerContextValue = {
  activeSection: NavSection
  /** Wide desktop owns a full-width title row (icons + label/trail + tools). */
  bannerActive: boolean
  host: HTMLDivElement | null
  setHost: (el: HTMLElement | null) => void
}

const SectionBannerContext = createContext<SectionBannerContextValue | null>(
  null,
)

export function useSectionBannerPlacement(): 'banner' | 'inline' {
  const ctx = useContext(SectionBannerContext)
  return ctx?.bannerActive ? 'banner' : 'inline'
}

/**
 * Full-width section bar on wide desktop — one connected frame:
 * gray pill | top+bottom bridge | gray tools (and/or Review strip).
 * Drill-in: gray pill (trail + icons) | bridge | gray tools (Back as first
 * face, then page tools) — same row as Mobile's head. Left pill stays
 * content-sized — nav icons never jet right; free width is the bridge.
 * Mobile crumb row lives in the panel head (NavBreadcrumbMobile) — not here.
 */
export function WalletSectionBanner({
  activeSection,
  bannerActive,
  label,
  trail,
  nav,
  children,
  dataHasTrail,
}: {
  activeSection: NavSection
  bannerActive: boolean
  /** Root label for non-drill-in sections (Activity, Apps, Friends, Settings). */
  label?: string
  /** Breadcrumb trail for drill-in views. */
  trail?: NavCrumb[]
  /** Navigation icons (pills) rendered inside the left pill. */
  nav?: ReactNode
  /** Page tools portalled in by the active section. */
  children?: ReactNode
  /** Internal: whether this banner has a trail (drill-in). */
  dataHasTrail?: boolean
}) {
  if (!bannerActive) {
    return null
  }

  const drillIn = Boolean(trail?.length)
  const hostRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const root = hostRef.current
    if (!root) return
    const observer = new ResizeObserver(() => {
      root.style.setProperty('--wallet-nav-pill-width', `${root.offsetWidth}px`)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      className="wallet-nav-section-banner connected-panel-head"
      data-has-trail={dataHasTrail || drillIn}
      data-active-section={activeSection}
    >
      <div
        ref={hostRef}
        className="wallet-nav-section-banner-pill"
        data-drill-in={drillIn}
      >
        {drillIn ? (
          <div className="wallet-nav-section-banner-trail">
            <NavBreadcrumbTrail crumbs={trail!} />
          </div>
        ) : label ? (
          <div className="wallet-nav-section-banner-label">
            <h2>{label}</h2>
          </div>
        ) : null}
        {nav}
      </div>
      <div className="wallet-nav-section-banner-bridge" />
      <div className="wallet-nav-section-banner-tools">{children}</div>
    </div>
  )
}

/**
 * Provides the banner tools host so a section can portal page tools into the
 * banner row. Only the banner-active section's portal mounts.
 */
export function WalletSectionBannerProvider({
  activeSection,
  bannerActive,
  children,
}: {
  activeSection: NavSection
  bannerActive: boolean
  children: ReactNode
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const setHost = useCallback((el: HTMLElement | null) => {
    if (el instanceof HTMLDivElement) {
      hostRef.current = el
    }
  }, [])
  const ctx: SectionBannerContextValue = useMemo(
    () => ({
      activeSection,
      bannerActive,
      host: hostRef.current,
      setHost,
    }),
    [activeSection, bannerActive],
  )
  return (
    <SectionBannerContext.Provider value={ctx}>
      {children}
    </SectionBannerContext.Provider>
  )
}

/**
 * Renders page tools into the section title row. Only the active section's
 * portal mounts — other kept-alive panels stay silent (no shared-slot leak).
 */
export function SectionBannerTools({
  section,
  children,
}: {
  section: NavSection
  children: ReactNode
}) {
  const ctx = useContext(SectionBannerContext)
  if (!ctx?.bannerActive || !ctx.host || ctx.activeSection !== section) {
    return null
  }
  return createPortal(children, ctx.host)
}
