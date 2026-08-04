/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonAvatarVariant {
  /**
 * @default "md"
 */
size: "xs" | "sm" | "md" | "lg" | "xl"
}

type AeonAvatarVariantMap = {
  [key in keyof AeonAvatarVariant]: Array<AeonAvatarVariant[key]>
}

type AeonAvatarSlot = "root" | "image" | "fallback" | "badge"

export type AeonAvatarVariantProps = {
  [key in keyof AeonAvatarVariant]?: ConditionalValue<AeonAvatarVariant[key]> | undefined
}

export interface AeonAvatarRecipe {
  __slot: AeonAvatarSlot
  __type: AeonAvatarVariantProps
  (props?: AeonAvatarVariantProps): Pretty<Record<AeonAvatarSlot, string>>
  raw: (props?: AeonAvatarVariantProps) => AeonAvatarVariantProps
  variantMap: AeonAvatarVariantMap
  variantKeys: Array<keyof AeonAvatarVariant>
  splitVariantProps<Props extends AeonAvatarVariantProps>(props: Props): [AeonAvatarVariantProps, Pretty<DistributiveOmit<Props, keyof AeonAvatarVariantProps>>]
  getVariantProps: (props?: AeonAvatarVariantProps) => AeonAvatarVariantProps
}

/**
 * Aeon avatar — always-round profile image with initials fallback + presence
 */
export declare const aeonAvatar: AeonAvatarRecipe