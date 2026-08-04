/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonNavVariant {
  /**
 * @default "md"
 */
size: "sm" | "md" | "lg"
/**
 * @default "inline"
 */
layout: "inline" | "dock"
}

type AeonNavVariantMap = {
  [key in keyof AeonNavVariant]: Array<AeonNavVariant[key]>
}

type AeonNavSlot = "root" | "item" | "indicator" | "label" | "icon" | "badge"

export type AeonNavVariantProps = {
  [key in keyof AeonNavVariant]?: ConditionalValue<AeonNavVariant[key]> | undefined
}

export interface AeonNavRecipe {
  __slot: AeonNavSlot
  __type: AeonNavVariantProps
  (props?: AeonNavVariantProps): Pretty<Record<AeonNavSlot, string>>
  raw: (props?: AeonNavVariantProps) => AeonNavVariantProps
  variantMap: AeonNavVariantMap
  variantKeys: Array<keyof AeonNavVariant>
  splitVariantProps<Props extends AeonNavVariantProps>(props: Props): [AeonNavVariantProps, Pretty<DistributiveOmit<Props, keyof AeonNavVariantProps>>]
  getVariantProps: (props?: AeonNavVariantProps) => AeonNavVariantProps
}


export declare const aeonNav: AeonNavRecipe