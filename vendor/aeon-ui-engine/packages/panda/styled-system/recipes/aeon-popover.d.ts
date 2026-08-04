/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonPopoverVariant {
  
}

type AeonPopoverVariantMap = {
  [key in keyof AeonPopoverVariant]: Array<AeonPopoverVariant[key]>
}

type AeonPopoverSlot = "root" | "trigger" | "positioner" | "content" | "arrow" | "closeTrigger"

export type AeonPopoverVariantProps = {
  [key in keyof AeonPopoverVariant]?: ConditionalValue<AeonPopoverVariant[key]> | undefined
}

export interface AeonPopoverRecipe {
  __slot: AeonPopoverSlot
  __type: AeonPopoverVariantProps
  (props?: AeonPopoverVariantProps): Pretty<Record<AeonPopoverSlot, string>>
  raw: (props?: AeonPopoverVariantProps) => AeonPopoverVariantProps
  variantMap: AeonPopoverVariantMap
  variantKeys: Array<keyof AeonPopoverVariant>
  splitVariantProps<Props extends AeonPopoverVariantProps>(props: Props): [AeonPopoverVariantProps, Pretty<DistributiveOmit<Props, keyof AeonPopoverVariantProps>>]
  getVariantProps: (props?: AeonPopoverVariantProps) => AeonPopoverVariantProps
}


export declare const aeonPopover: AeonPopoverRecipe