import type { ComponentType, SVGProps } from 'react'
import {
  AutoPayIcon,
  CollectablesIcon,
  ProfileScopeIcon,
  ReceiveIcon,
  WalletScopeIcon,
} from './icons'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

const SCOPE_ICONS: Record<string, ComponentType<IconProps>> = {
  'wallet-access': WalletScopeIcon,
  'tokens-view': CollectablesIcon,
  receive: ReceiveIcon,
  'auto-pay': AutoPayIcon,
  'items-view': CollectablesIcon,
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
