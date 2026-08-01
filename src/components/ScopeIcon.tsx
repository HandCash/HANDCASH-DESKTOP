import type { ComponentType, SVGProps } from 'react'
import {
  AutoPayIcon,
  CollectablesIcon,
  EncryptIcon,
  PayScopeIcon,
  ProfileScopeIcon,
  ReceiveIcon,
  SendIcon,
  WalletScopeIcon,
} from './icons'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

const SCOPE_ICONS: Record<string, ComponentType<IconProps>> = {
  'public-profile': ProfileScopeIcon,
  pay: PayScopeIcon,
  wallet: WalletScopeIcon,
  encrypt: EncryptIcon,
  'auto-pay': AutoPayIcon,
  'items-view': CollectablesIcon,
  'items-send': SendIcon,
  'items-receive': ReceiveIcon,
}

export function ScopeIcon({
  scopeId,
  size = 14,
}: {
  scopeId: string
  size?: number
}) {
  const Icon = SCOPE_ICONS[scopeId] ?? ProfileScopeIcon
  return <Icon size={size} />
}
