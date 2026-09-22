import type { ReactNode } from 'react'

export type IconProps = {
  size?: number
  className?: string
}

function Icon({ size = 18, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/**
 * Material Icons — `diamond`.
 *
 * Five filled facets. An earlier version spliced MDI's *stroke* facet lines
 * onto a filled outline: with `fill="currentColor"` each open subpath closed
 * itself into a blob over a solid diamond.
 */
export function CollectablesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12.16 3 11.84 3 9.21 8.25 14.79 8.25ZM16.46 8.25 21.62 8.25 19 3 13.84 3ZM21.38 9.75 12.75 9.75 12.75 20.1ZM11.25 20.1 11.25 9.75 2.62 9.75ZM7.54 8.25 10.16 3 5 3 2.38 8.25Z" />
    </Icon>
  )
}

/** Material Design `local_offer`. */
export function ListingIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21.41 11.58 12.41 2.58A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 .59 1.41l9 9a2 2 0 0 0 2.82 0l7-7a2 2 0 0 0 0-2.83zM6.5 8A1.5 1.5 0 1 1 6.5 5a1.5 1.5 0 0 1 0 3z" />
    </Icon>
  )
}

/** Material Icons — `search_off` (magnifier plus a cross, not a struck-through lens). */
export function SearchOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15.5,14h-0.79l-0.28-0.27C15.41,12.59,16,11.11,16,9.5C16,5.91,13.09,3,9.5,3C6.08,3,3.28,5.64,3.03,9h2.02 C5.3,6.75,7.18,5,9.5,5C11.99,5,14,7.01,14,9.5S11.99,14,9.5,14c-0.17,0-0.33-0.03-0.5-0.05v2.02C9.17,15.99,9.33,16,9.5,16 c1.61,0,3.09-0.59,4.23-1.57L14,14.71v0.79l5,4.99L20.49,19L15.5,14z" />
      <path d="M6.47,10.82 4,13.29 1.53,10.82 0.82,11.53 3.29,14 0.82,16.47 1.53,17.18 4,14.71 6.47,17.18 7.18,16.47 4.71,14 7.18,11.53z" />
    </Icon>
  )
}
