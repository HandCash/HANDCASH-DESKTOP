/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonBadgeVariant {
  /**
 * @default "default"
 */
variant: "default" | "accent" | "danger"
}

type AeonBadgeVariantMap = {
  [key in keyof AeonBadgeVariant]: Array<AeonBadgeVariant[key]>
}



export type AeonBadgeVariantProps = {
  [key in keyof AeonBadgeVariant]?: ConditionalValue<AeonBadgeVariant[key]> | undefined
}

export interface AeonBadgeRecipe {
  
  __type: AeonBadgeVariantProps
  (props?: AeonBadgeVariantProps): string
  raw: (props?: AeonBadgeVariantProps) => AeonBadgeVariantProps
  variantMap: AeonBadgeVariantMap
  variantKeys: Array<keyof AeonBadgeVariant>
  splitVariantProps<Props extends AeonBadgeVariantProps>(props: Props): [AeonBadgeVariantProps, Pretty<DistributiveOmit<Props, keyof AeonBadgeVariantProps>>]
  getVariantProps: (props?: AeonBadgeVariantProps) => AeonBadgeVariantProps
}


export declare const aeonBadge: AeonBadgeRecipe