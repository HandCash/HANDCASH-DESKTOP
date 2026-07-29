import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & {
  size?: number
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

export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.4 20.6 21 12 3.4 3.4l.1 6.6L15 12 3.5 14z" />
    </Icon>
  )
}

export function ReceiveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11 4h2v9.17l3.59-3.58L18 11l-6 6-6-6 1.41-1.41L11 13.17V4Z" />
      <path d="M5 18h14v2H5z" />
    </Icon>
  )
}

export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M17 8h-1V6a4 4 0 1 0-8 0v2H7c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2Zm-7-2a2 2 0 1 1 4 0v2h-4V6Zm7 14H7V10h10v10Zm-5-1a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
    </Icon>
  )
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16 1H6c-1.1 0-2 .9-2 2v12h2V3h10V1Zm3 4H10c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h9c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2Zm0 16H10V7h9v14Z" />
    </Icon>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.2 16.6 4.8 12.2l1.4-1.4 3 3 8-8 1.4 1.4-9.4 9.4Z" />
    </Icon>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.1A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z" />
    </Icon>
  )
}

export function AppsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z" />
    </Icon>
  )
}

/** Material Icons — `history` */
export function TransactionsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
    </Icon>
  )
}

/** Material Icons — `filter_list` */
export function FilterIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z" />
    </Icon>
  )
}

/** Material Icons — `timeline` */
export function ActivityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M23 8c0 1.1-.9 2-2 2-.18 0-.35-.02-.51-.07l-3.56 3.55c.05.16.07.33.07.51 0 1.1-.9 2-2 2s-2-.9-2-2c0-.18.02-.36.07-.51l-2.55-2.55c-.16.05-.34.07-.52.07s-.36-.02-.52-.07l-4.55 4.56c.05.16.07.33.07.51 0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2c.18 0 .35.02.51.07l4.56-4.55C8.02 9.36 8 9.18 8 9c0-1.1.9-2 2-2s2 .9 2 2c0 .18-.02.36-.07.51l2.55 2.55c.16-.05.34-.07.52-.07s.36.02.52.07l3.55-3.56C19.02 8.35 19 8.18 19 8c0-1.1.9-2 2-2s2 .9 2 2z" />
    </Icon>
  )
}

/** Material Icons — `inventory_2` */
export function InventoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 2H4c-1 0-2 .9-2 2v3.01c0 .72.43 1.34 1 1.69V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.57-.35 1-.97 1-1.69V4c0-1.1-1-2-2-2zm-1 18H5V9h14v11zm1-13H4V4h16v3z" />
    </Icon>
  )
}

/** Material Icons — `group` */
export function FriendsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
    </Icon>
  )
}

export function IdentityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3.3 0-8 1.7-8 5v1h16v-1c0-3.3-4.7-5-8-5Z" />
    </Icon>
  )
}

export function QrIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3h8v8H3V3Zm2 2v4h4V5H5Zm8-2h8v8h-8V3Zm2 2v4h4V5h-4ZM3 13h8v8H3v-8Zm2 2v4h4v-4H5Zm10 0h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm4 0h2v4h-4v-2h2v-2Zm-2 2h-2v2h4v-2h-2Z" />
    </Icon>
  )
}

export function EncryptIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8Z" />
    </Icon>
  )
}

export function AutoPayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11.5 2 6 12h5l-.5 8L18 10h-5l-1.5-8Z" />
    </Icon>
  )
}

export function ProfileScopeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3.3 0-8 1.7-8 5v1h16v-1c0-3.3-4.7-5-8-5Z" />
    </Icon>
  )
}

export function PayScopeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.4 20.6 21 12 3.4 3.4l.1 6.6L15 12 3.5 14z" />
    </Icon>
  )
}

export function WalletScopeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 7H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Zm0 10H4V9h16v8Zm-3-5.5a1.5 1.5 0 1 1-1.5 1.5A1.5 1.5 0 0 1 17 11.5Z" />
    </Icon>
  )
}

/** Material Icons — `rocket` (filled) */
export function LaunchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.5s4.5 2.04 4.5 10.5c0 2.49-1.04 5.57-1.6 7H9.1c-.56-1.43-1.6-4.51-1.6-7C7.5 4.54 12 2.5 12 2.5zm2 8.5c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2 2-.9 2-2zm-6.31 9.52c-.48-1.23-1.52-4.17-1.67-6.87l-1.13.75c-.56.38-.89 1-.89 1.67V22l3.69-1.48zM20 22v-5.93c0-.67-.33-1.29-.89-1.66l-1.13-.75c-.15 2.69-1.2 5.64-1.67 6.87L20 22z" />
    </Icon>
  )
}

/** Material Icons — `view_list` */
export function ViewListIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 14h4v-4H3v4zm0 5h4v-4H3v4zM3 9h4V5H3v4zm5 5h13v-4H8v4zm0 5h13v-4H8v4zM8 5v4h13V5H8z" />
    </Icon>
  )
}

/** Material Icons — `grid_view` */
export function ViewGridIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3v8h8V3H3zm6 6H5V5h4v4zm-6 4v8h8v-8H3zm6 6H5v-4h4v4zm4-16v8h8V3h-8zm6 6h-4V5h4v4zm-6 4v8h8v-8h-8zm6 6h-4v-4h4v4z" />
    </Icon>
  )
}
