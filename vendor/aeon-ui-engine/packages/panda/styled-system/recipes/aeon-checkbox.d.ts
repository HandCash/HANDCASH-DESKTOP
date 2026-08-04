/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonCheckboxVariant {
  
}

type AeonCheckboxVariantMap = {
  [key in keyof AeonCheckboxVariant]: Array<AeonCheckboxVariant[key]>
}

type AeonCheckboxSlot = "root" | "control" | "indicator" | "label" | "hiddenInput"

export type AeonCheckboxVariantProps = {
  [key in keyof AeonCheckboxVariant]?: ConditionalValue<AeonCheckboxVariant[key]> | undefined
}

export interface AeonCheckboxRecipe {
  __slot: AeonCheckboxSlot
  __type: AeonCheckboxVariantProps
  (props?: AeonCheckboxVariantProps): Pretty<Record<AeonCheckboxSlot, string>>
  raw: (props?: AeonCheckboxVariantProps) => AeonCheckboxVariantProps
  variantMap: AeonCheckboxVariantMap
  variantKeys: Array<keyof AeonCheckboxVariant>
  splitVariantProps<Props extends AeonCheckboxVariantProps>(props: Props): [AeonCheckboxVariantProps, Pretty<DistributiveOmit<Props, keyof AeonCheckboxVariantProps>>]
  getVariantProps: (props?: AeonCheckboxVariantProps) => AeonCheckboxVariantProps
}


export declare const aeonCheckbox: AeonCheckboxRecipe