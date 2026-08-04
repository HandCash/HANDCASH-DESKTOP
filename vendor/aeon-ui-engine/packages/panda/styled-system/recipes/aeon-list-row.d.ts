/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonListRowVariant {
  
}

type AeonListRowVariantMap = {
  [key in keyof AeonListRowVariant]: Array<AeonListRowVariant[key]>
}

type AeonListRowSlot = "root" | "leading" | "label" | "description" | "trailing"

export type AeonListRowVariantProps = {
  [key in keyof AeonListRowVariant]?: ConditionalValue<AeonListRowVariant[key]> | undefined
}

export interface AeonListRowRecipe {
  __slot: AeonListRowSlot
  __type: AeonListRowVariantProps
  (props?: AeonListRowVariantProps): Pretty<Record<AeonListRowSlot, string>>
  raw: (props?: AeonListRowVariantProps) => AeonListRowVariantProps
  variantMap: AeonListRowVariantMap
  variantKeys: Array<keyof AeonListRowVariant>
  splitVariantProps<Props extends AeonListRowVariantProps>(props: Props): [AeonListRowVariantProps, Pretty<DistributiveOmit<Props, keyof AeonListRowVariantProps>>]
  getVariantProps: (props?: AeonListRowVariantProps) => AeonListRowVariantProps
}

/**
 * Settings / people list row — full-width hit target
 */
export declare const aeonListRow: AeonListRowRecipe