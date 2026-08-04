/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonTooltipVariant {
  
}

type AeonTooltipVariantMap = {
  [key in keyof AeonTooltipVariant]: Array<AeonTooltipVariant[key]>
}

type AeonTooltipSlot = "root" | "trigger" | "positioner" | "content" | "arrow"

export type AeonTooltipVariantProps = {
  [key in keyof AeonTooltipVariant]?: ConditionalValue<AeonTooltipVariant[key]> | undefined
}

export interface AeonTooltipRecipe {
  __slot: AeonTooltipSlot
  __type: AeonTooltipVariantProps
  (props?: AeonTooltipVariantProps): Pretty<Record<AeonTooltipSlot, string>>
  raw: (props?: AeonTooltipVariantProps) => AeonTooltipVariantProps
  variantMap: AeonTooltipVariantMap
  variantKeys: Array<keyof AeonTooltipVariant>
  splitVariantProps<Props extends AeonTooltipVariantProps>(props: Props): [AeonTooltipVariantProps, Pretty<DistributiveOmit<Props, keyof AeonTooltipVariantProps>>]
  getVariantProps: (props?: AeonTooltipVariantProps) => AeonTooltipVariantProps
}


export declare const aeonTooltip: AeonTooltipRecipe