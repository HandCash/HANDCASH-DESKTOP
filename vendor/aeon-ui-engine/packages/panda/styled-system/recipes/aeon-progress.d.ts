/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonProgressVariant {
  
}

type AeonProgressVariantMap = {
  [key in keyof AeonProgressVariant]: Array<AeonProgressVariant[key]>
}

type AeonProgressSlot = "root" | "track" | "range" | "label"

export type AeonProgressVariantProps = {
  [key in keyof AeonProgressVariant]?: ConditionalValue<AeonProgressVariant[key]> | undefined
}

export interface AeonProgressRecipe {
  __slot: AeonProgressSlot
  __type: AeonProgressVariantProps
  (props?: AeonProgressVariantProps): Pretty<Record<AeonProgressSlot, string>>
  raw: (props?: AeonProgressVariantProps) => AeonProgressVariantProps
  variantMap: AeonProgressVariantMap
  variantKeys: Array<keyof AeonProgressVariant>
  splitVariantProps<Props extends AeonProgressVariantProps>(props: Props): [AeonProgressVariantProps, Pretty<DistributiveOmit<Props, keyof AeonProgressVariantProps>>]
  getVariantProps: (props?: AeonProgressVariantProps) => AeonProgressVariantProps
}


export declare const aeonProgress: AeonProgressRecipe