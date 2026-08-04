/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonThreadVariant {
  
}

type AeonThreadVariantMap = {
  [key in keyof AeonThreadVariant]: Array<AeonThreadVariant[key]>
}

type AeonThreadSlot = "root" | "list" | "item" | "bubble" | "meta" | "day" | "bind" | "card" | "cardTitle" | "cardBody" | "cardActions"

export type AeonThreadVariantProps = {
  [key in keyof AeonThreadVariant]?: ConditionalValue<AeonThreadVariant[key]> | undefined
}

export interface AeonThreadRecipe {
  __slot: AeonThreadSlot
  __type: AeonThreadVariantProps
  (props?: AeonThreadVariantProps): Pretty<Record<AeonThreadSlot, string>>
  raw: (props?: AeonThreadVariantProps) => AeonThreadVariantProps
  variantMap: AeonThreadVariantMap
  variantKeys: Array<keyof AeonThreadVariant>
  splitVariantProps<Props extends AeonThreadVariantProps>(props: Props): [AeonThreadVariantProps, Pretty<DistributiveOmit<Props, keyof AeonThreadVariantProps>>]
  getVariantProps: (props?: AeonThreadVariantProps) => AeonThreadVariantProps
}


export declare const aeonThread: AeonThreadRecipe