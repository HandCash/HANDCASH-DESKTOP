/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonTabsVariant {
  
}

type AeonTabsVariantMap = {
  [key in keyof AeonTabsVariant]: Array<AeonTabsVariant[key]>
}

type AeonTabsSlot = "root" | "list" | "trigger" | "content" | "indicator"

export type AeonTabsVariantProps = {
  [key in keyof AeonTabsVariant]?: ConditionalValue<AeonTabsVariant[key]> | undefined
}

export interface AeonTabsRecipe {
  __slot: AeonTabsSlot
  __type: AeonTabsVariantProps
  (props?: AeonTabsVariantProps): Pretty<Record<AeonTabsSlot, string>>
  raw: (props?: AeonTabsVariantProps) => AeonTabsVariantProps
  variantMap: AeonTabsVariantMap
  variantKeys: Array<keyof AeonTabsVariant>
  splitVariantProps<Props extends AeonTabsVariantProps>(props: Props): [AeonTabsVariantProps, Pretty<DistributiveOmit<Props, keyof AeonTabsVariantProps>>]
  getVariantProps: (props?: AeonTabsVariantProps) => AeonTabsVariantProps
}


export declare const aeonTabs: AeonTabsRecipe