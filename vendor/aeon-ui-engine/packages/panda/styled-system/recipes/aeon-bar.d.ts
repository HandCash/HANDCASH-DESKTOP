/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonBarVariant {
  /**
 * @default "sm"
 */
size: "xs" | "sm" | "md" | "lg"
sticky: boolean
placement: "top" | "bottom" | "inline"
/**
 * @default "shrink"
 */
collapse: "shrink" | "wrap" | "collapse-center"
}

type AeonBarVariantMap = {
  [key in keyof AeonBarVariant]: Array<AeonBarVariant[key]>
}

type AeonBarSlot = "root" | "leading" | "center" | "trailing" | "seam"

export type AeonBarVariantProps = {
  [key in keyof AeonBarVariant]?: ConditionalValue<AeonBarVariant[key]> | undefined
}

export interface AeonBarRecipe {
  __slot: AeonBarSlot
  __type: AeonBarVariantProps
  (props?: AeonBarVariantProps): Pretty<Record<AeonBarSlot, string>>
  raw: (props?: AeonBarVariantProps) => AeonBarVariantProps
  variantMap: AeonBarVariantMap
  variantKeys: Array<keyof AeonBarVariant>
  splitVariantProps<Props extends AeonBarVariantProps>(props: Props): [AeonBarVariantProps, Pretty<DistributiveOmit<Props, keyof AeonBarVariantProps>>]
  getVariantProps: (props?: AeonBarVariantProps) => AeonBarVariantProps
}


export declare const aeonBar: AeonBarRecipe