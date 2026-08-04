/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonSeparatorVariant {
  /**
 * @default "horizontal"
 */
orientation: "horizontal" | "vertical"
}

type AeonSeparatorVariantMap = {
  [key in keyof AeonSeparatorVariant]: Array<AeonSeparatorVariant[key]>
}

type AeonSeparatorSlot = "root"

export type AeonSeparatorVariantProps = {
  [key in keyof AeonSeparatorVariant]?: ConditionalValue<AeonSeparatorVariant[key]> | undefined
}

export interface AeonSeparatorRecipe {
  __slot: AeonSeparatorSlot
  __type: AeonSeparatorVariantProps
  (props?: AeonSeparatorVariantProps): Pretty<Record<AeonSeparatorSlot, string>>
  raw: (props?: AeonSeparatorVariantProps) => AeonSeparatorVariantProps
  variantMap: AeonSeparatorVariantMap
  variantKeys: Array<keyof AeonSeparatorVariant>
  splitVariantProps<Props extends AeonSeparatorVariantProps>(props: Props): [AeonSeparatorVariantProps, Pretty<DistributiveOmit<Props, keyof AeonSeparatorVariantProps>>]
  getVariantProps: (props?: AeonSeparatorVariantProps) => AeonSeparatorVariantProps
}


export declare const aeonSeparator: AeonSeparatorRecipe