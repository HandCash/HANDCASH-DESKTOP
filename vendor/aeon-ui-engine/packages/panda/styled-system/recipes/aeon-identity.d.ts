/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonIdentityVariant {
  /**
 * @default "md"
 */
size: "sm" | "md" | "lg"
}

type AeonIdentityVariantMap = {
  [key in keyof AeonIdentityVariant]: Array<AeonIdentityVariant[key]>
}

type AeonIdentitySlot = "root" | "avatar" | "title" | "subtitle" | "meta" | "trailing"

export type AeonIdentityVariantProps = {
  [key in keyof AeonIdentityVariant]?: ConditionalValue<AeonIdentityVariant[key]> | undefined
}

export interface AeonIdentityRecipe {
  __slot: AeonIdentitySlot
  __type: AeonIdentityVariantProps
  (props?: AeonIdentityVariantProps): Pretty<Record<AeonIdentitySlot, string>>
  raw: (props?: AeonIdentityVariantProps) => AeonIdentityVariantProps
  variantMap: AeonIdentityVariantMap
  variantKeys: Array<keyof AeonIdentityVariant>
  splitVariantProps<Props extends AeonIdentityVariantProps>(props: Props): [AeonIdentityVariantProps, Pretty<DistributiveOmit<Props, keyof AeonIdentityVariantProps>>]
  getVariantProps: (props?: AeonIdentityVariantProps) => AeonIdentityVariantProps
}

/**
 * Identity strip — avatar + title + subtitle
 */
export declare const aeonIdentity: AeonIdentityRecipe