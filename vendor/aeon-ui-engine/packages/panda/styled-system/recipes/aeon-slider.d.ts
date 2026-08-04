/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonSliderVariant {
  
}

type AeonSliderVariantMap = {
  [key in keyof AeonSliderVariant]: Array<AeonSliderVariant[key]>
}

type AeonSliderSlot = "root" | "track" | "range" | "thumb" | "valueText"

export type AeonSliderVariantProps = {
  [key in keyof AeonSliderVariant]?: ConditionalValue<AeonSliderVariant[key]> | undefined
}

export interface AeonSliderRecipe {
  __slot: AeonSliderSlot
  __type: AeonSliderVariantProps
  (props?: AeonSliderVariantProps): Pretty<Record<AeonSliderSlot, string>>
  raw: (props?: AeonSliderVariantProps) => AeonSliderVariantProps
  variantMap: AeonSliderVariantMap
  variantKeys: Array<keyof AeonSliderVariant>
  splitVariantProps<Props extends AeonSliderVariantProps>(props: Props): [AeonSliderVariantProps, Pretty<DistributiveOmit<Props, keyof AeonSliderVariantProps>>]
  getVariantProps: (props?: AeonSliderVariantProps) => AeonSliderVariantProps
}


export declare const aeonSlider: AeonSliderRecipe