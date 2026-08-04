/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonContentVariant {
  /**
 * @default "start"
 */
align: "start" | "center"
}

type AeonContentVariantMap = {
  [key in keyof AeonContentVariant]: Array<AeonContentVariant[key]>
}

type AeonContentSlot = "root" | "toolbar" | "body" | "pending" | "empty" | "error" | "success" | "sentinel"

export type AeonContentVariantProps = {
  [key in keyof AeonContentVariant]?: ConditionalValue<AeonContentVariant[key]> | undefined
}

export interface AeonContentRecipe {
  __slot: AeonContentSlot
  __type: AeonContentVariantProps
  (props?: AeonContentVariantProps): Pretty<Record<AeonContentSlot, string>>
  raw: (props?: AeonContentVariantProps) => AeonContentVariantProps
  variantMap: AeonContentVariantMap
  variantKeys: Array<keyof AeonContentVariant>
  splitVariantProps<Props extends AeonContentVariantProps>(props: Props): [AeonContentVariantProps, Pretty<DistributiveOmit<Props, keyof AeonContentVariantProps>>]
  getVariantProps: (props?: AeonContentVariantProps) => AeonContentVariantProps
}


export declare const aeonContent: AeonContentRecipe