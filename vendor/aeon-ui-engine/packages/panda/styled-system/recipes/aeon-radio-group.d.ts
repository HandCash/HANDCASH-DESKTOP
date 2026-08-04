/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonRadioGroupVariant {
  
}

type AeonRadioGroupVariantMap = {
  [key in keyof AeonRadioGroupVariant]: Array<AeonRadioGroupVariant[key]>
}

type AeonRadioGroupSlot = "root" | "item" | "itemControl" | "itemIndicator" | "itemLabel"

export type AeonRadioGroupVariantProps = {
  [key in keyof AeonRadioGroupVariant]?: ConditionalValue<AeonRadioGroupVariant[key]> | undefined
}

export interface AeonRadioGroupRecipe {
  __slot: AeonRadioGroupSlot
  __type: AeonRadioGroupVariantProps
  (props?: AeonRadioGroupVariantProps): Pretty<Record<AeonRadioGroupSlot, string>>
  raw: (props?: AeonRadioGroupVariantProps) => AeonRadioGroupVariantProps
  variantMap: AeonRadioGroupVariantMap
  variantKeys: Array<keyof AeonRadioGroupVariant>
  splitVariantProps<Props extends AeonRadioGroupVariantProps>(props: Props): [AeonRadioGroupVariantProps, Pretty<DistributiveOmit<Props, keyof AeonRadioGroupVariantProps>>]
  getVariantProps: (props?: AeonRadioGroupVariantProps) => AeonRadioGroupVariantProps
}


export declare const aeonRadioGroup: AeonRadioGroupRecipe