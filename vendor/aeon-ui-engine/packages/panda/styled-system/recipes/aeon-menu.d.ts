/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonMenuVariant {
  
}

type AeonMenuVariantMap = {
  [key in keyof AeonMenuVariant]: Array<AeonMenuVariant[key]>
}

type AeonMenuSlot = "root" | "trigger" | "positioner" | "content" | "item" | "separator"

export type AeonMenuVariantProps = {
  [key in keyof AeonMenuVariant]?: ConditionalValue<AeonMenuVariant[key]> | undefined
}

export interface AeonMenuRecipe {
  __slot: AeonMenuSlot
  __type: AeonMenuVariantProps
  (props?: AeonMenuVariantProps): Pretty<Record<AeonMenuSlot, string>>
  raw: (props?: AeonMenuVariantProps) => AeonMenuVariantProps
  variantMap: AeonMenuVariantMap
  variantKeys: Array<keyof AeonMenuVariant>
  splitVariantProps<Props extends AeonMenuVariantProps>(props: Props): [AeonMenuVariantProps, Pretty<DistributiveOmit<Props, keyof AeonMenuVariantProps>>]
  getVariantProps: (props?: AeonMenuVariantProps) => AeonMenuVariantProps
}


export declare const aeonMenu: AeonMenuRecipe