/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonButtonVariant {
  /**
 * @default "solid"
 */
variant: "solid" | "outline" | "ghost"
/**
 * @default "sm"
 */
size: "xs" | "sm" | "md" | "lg"
}

type AeonButtonVariantMap = {
  [key in keyof AeonButtonVariant]: Array<AeonButtonVariant[key]>
}



export type AeonButtonVariantProps = {
  [key in keyof AeonButtonVariant]?: ConditionalValue<AeonButtonVariant[key]> | undefined
}

export interface AeonButtonRecipe {
  
  __type: AeonButtonVariantProps
  (props?: AeonButtonVariantProps): string
  raw: (props?: AeonButtonVariantProps) => AeonButtonVariantProps
  variantMap: AeonButtonVariantMap
  variantKeys: Array<keyof AeonButtonVariant>
  splitVariantProps<Props extends AeonButtonVariantProps>(props: Props): [AeonButtonVariantProps, Pretty<DistributiveOmit<Props, keyof AeonButtonVariantProps>>]
  getVariantProps: (props?: AeonButtonVariantProps) => AeonButtonVariantProps
}

/**
 * Aeon button styles
 */
export declare const aeonButton: AeonButtonRecipe