/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonScrollVariant {
  /**
 * @default "both"
 */
axis: "y" | "x" | "both"
/**
 * @default "md"
 */
maxH: "sm" | "md" | "lg"
/**
 * @default "full"
 */
maxW: "full" | "md"
}

type AeonScrollVariantMap = {
  [key in keyof AeonScrollVariant]: Array<AeonScrollVariant[key]>
}

type AeonScrollSlot = "root" | "viewport" | "content"

export type AeonScrollVariantProps = {
  [key in keyof AeonScrollVariant]?: ConditionalValue<AeonScrollVariant[key]> | undefined
}

export interface AeonScrollRecipe {
  __slot: AeonScrollSlot
  __type: AeonScrollVariantProps
  (props?: AeonScrollVariantProps): Pretty<Record<AeonScrollSlot, string>>
  raw: (props?: AeonScrollVariantProps) => AeonScrollVariantProps
  variantMap: AeonScrollVariantMap
  variantKeys: Array<keyof AeonScrollVariant>
  splitVariantProps<Props extends AeonScrollVariantProps>(props: Props): [AeonScrollVariantProps, Pretty<DistributiveOmit<Props, keyof AeonScrollVariantProps>>]
  getVariantProps: (props?: AeonScrollVariantProps) => AeonScrollVariantProps
}

/**
 * Scroll viewport with axis + edge states on data-aeon-state
 */
export declare const aeonScroll: AeonScrollRecipe