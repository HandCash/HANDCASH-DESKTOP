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

/** Material Design `diamond`. */
export function CollectablesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16 9h3l-5 7M10 9h4l-2 8M5 9h3l2 7M15 4h2l2 3h-3M11 4h2l1 3h-4M7 4h2L8 7H5M6 2 2 8l10 14L22 8l-4-6H6z" />
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

/** Material Design `search_off`. */
export function SearchOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.27 3 16.73 16.73-1.27 1.27-3.34-3.34A8 8 0 0 1 4.34 7.61L3 6.27 4.27 3zm2.34 5.88A5.98 5.98 0 0 0 14.9 16.17L6.61 7.88zM10 4a8 8 0 0 1 6.32 12.91l-1.45-1.45A6 6 0 0 0 7.09 7.68L5.64 6.23A7.96 7.96 0 0 1 10 4z" />
    </Icon>
  )
}
