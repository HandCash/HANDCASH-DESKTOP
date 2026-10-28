import type { ReactNode } from 'react'

type Props = {
  /** When true the slot unwraps (`display: contents`) into the parent flex. */
  active: boolean
  className?: string
  children: ReactNode
}

/**
 * Keep-alive mount wrapper for wallet section panels.
 *
 * Active → `display: contents` so the panel flexes as a direct stage child.
 * Inactive → `hidden` + `inert` so the panel cannot paint or receive hits.
 * CSS also forces `[hidden] { display: none !important }` because author
 * `display: contents` can otherwise beat the HTML hidden rule and leave
 * stacked panels eating Send / Collect / tab clicks.
 */
export function KeepAliveSlot({ active, className = 'wallet-nav-slot', children }: Props) {
  return (
    <div
      className={className}
      hidden={!active}
      // React 19 types `inert` as boolean | undefined.
      inert={active ? undefined : true}
    >
      {children}
    </div>
  )
}
