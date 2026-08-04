/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonButtonGroupVariant {
  /**
 * @default "horizontal"
 */
orientation: "horizontal" | "vertical"
/**
 * @default "sm"
 */
gap: "sm" | "md" | "lg"
}

type AeonButtonGroupVariantMap = {
  [key in keyof AeonButtonGroupVariant]: Array<AeonButtonGroupVariant[key]>
}



export type AeonButtonGroupVariantProps = {
  [key in keyof AeonButtonGroupVariant]?: ConditionalValue<AeonButtonGroupVariant[key]> | undefined
}

export interface AeonButtonGroupRecipe {
  
  __type: AeonButtonGroupVariantProps
  (props?: AeonButtonGroupVariantProps): string
  raw: (props?: AeonButtonGroupVariantProps) => AeonButtonGroupVariantProps
  variantMap: AeonButtonGroupVariantMap
  variantKeys: Array<keyof AeonButtonGroupVariant>
  splitVariantProps<Props extends AeonButtonGroupVariantProps>(props: Props): [AeonButtonGroupVariantProps, Pretty<DistributiveOmit<Props, keyof AeonButtonGroupVariantProps>>]
  getVariantProps: (props?: AeonButtonGroupVariantProps) => AeonButtonGroupVariantProps
}

/**
 * Horizontal or vertical stack of buttons with consistent spacing
 */
export declare const aeonButtonGroup: AeonButtonGroupRecipe