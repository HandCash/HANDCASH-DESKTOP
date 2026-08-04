/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonComboboxVariant {
  
}

type AeonComboboxVariantMap = {
  [key in keyof AeonComboboxVariant]: Array<AeonComboboxVariant[key]>
}

type AeonComboboxSlot = "root" | "input" | "icon" | "content" | "item" | "empty"

export type AeonComboboxVariantProps = {
  [key in keyof AeonComboboxVariant]?: ConditionalValue<AeonComboboxVariant[key]> | undefined
}

export interface AeonComboboxRecipe {
  __slot: AeonComboboxSlot
  __type: AeonComboboxVariantProps
  (props?: AeonComboboxVariantProps): Pretty<Record<AeonComboboxSlot, string>>
  raw: (props?: AeonComboboxVariantProps) => AeonComboboxVariantProps
  variantMap: AeonComboboxVariantMap
  variantKeys: Array<keyof AeonComboboxVariant>
  splitVariantProps<Props extends AeonComboboxVariantProps>(props: Props): [AeonComboboxVariantProps, Pretty<DistributiveOmit<Props, keyof AeonComboboxVariantProps>>]
  getVariantProps: (props?: AeonComboboxVariantProps) => AeonComboboxVariantProps
}

/**
 * Filterable combobox — input + listbox (extends select patterns)
 */
export declare const aeonCombobox: AeonComboboxRecipe