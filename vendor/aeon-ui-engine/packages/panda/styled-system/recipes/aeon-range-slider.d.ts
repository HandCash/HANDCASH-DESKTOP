/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonRangeSliderVariant {
  
}

type AeonRangeSliderVariantMap = {
  [key in keyof AeonRangeSliderVariant]: Array<AeonRangeSliderVariant[key]>
}

type AeonRangeSliderSlot = "root" | "track" | "range" | "thumb" | "valueText"

export type AeonRangeSliderVariantProps = {
  [key in keyof AeonRangeSliderVariant]?: ConditionalValue<AeonRangeSliderVariant[key]> | undefined
}

export interface AeonRangeSliderRecipe {
  __slot: AeonRangeSliderSlot
  __type: AeonRangeSliderVariantProps
  (props?: AeonRangeSliderVariantProps): Pretty<Record<AeonRangeSliderSlot, string>>
  raw: (props?: AeonRangeSliderVariantProps) => AeonRangeSliderVariantProps
  variantMap: AeonRangeSliderVariantMap
  variantKeys: Array<keyof AeonRangeSliderVariant>
  splitVariantProps<Props extends AeonRangeSliderVariantProps>(props: Props): [AeonRangeSliderVariantProps, Pretty<DistributiveOmit<Props, keyof AeonRangeSliderVariantProps>>]
  getVariantProps: (props?: AeonRangeSliderVariantProps) => AeonRangeSliderVariantProps
}


export declare const aeonRangeSlider: AeonRangeSliderRecipe