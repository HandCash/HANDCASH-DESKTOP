/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonSelectVariant {
  
}

type AeonSelectVariantMap = {
  [key in keyof AeonSelectVariant]: Array<AeonSelectVariant[key]>
}

type AeonSelectSlot = "root" | "trigger" | "value" | "icon" | "positioner" | "content" | "item"

export type AeonSelectVariantProps = {
  [key in keyof AeonSelectVariant]?: ConditionalValue<AeonSelectVariant[key]> | undefined
}

export interface AeonSelectRecipe {
  __slot: AeonSelectSlot
  __type: AeonSelectVariantProps
  (props?: AeonSelectVariantProps): Pretty<Record<AeonSelectSlot, string>>
  raw: (props?: AeonSelectVariantProps) => AeonSelectVariantProps
  variantMap: AeonSelectVariantMap
  variantKeys: Array<keyof AeonSelectVariant>
  splitVariantProps<Props extends AeonSelectVariantProps>(props: Props): [AeonSelectVariantProps, Pretty<DistributiveOmit<Props, keyof AeonSelectVariantProps>>]
  getVariantProps: (props?: AeonSelectVariantProps) => AeonSelectVariantProps
}

/**
 * Custom listbox select — no native OS dropdown chrome
 */
export declare const aeonSelect: AeonSelectRecipe