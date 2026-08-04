/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonAccordionVariant {
  
}

type AeonAccordionVariantMap = {
  [key in keyof AeonAccordionVariant]: Array<AeonAccordionVariant[key]>
}

type AeonAccordionSlot = "root" | "item" | "itemTrigger" | "itemContent" | "itemIndicator"

export type AeonAccordionVariantProps = {
  [key in keyof AeonAccordionVariant]?: ConditionalValue<AeonAccordionVariant[key]> | undefined
}

export interface AeonAccordionRecipe {
  __slot: AeonAccordionSlot
  __type: AeonAccordionVariantProps
  (props?: AeonAccordionVariantProps): Pretty<Record<AeonAccordionSlot, string>>
  raw: (props?: AeonAccordionVariantProps) => AeonAccordionVariantProps
  variantMap: AeonAccordionVariantMap
  variantKeys: Array<keyof AeonAccordionVariant>
  splitVariantProps<Props extends AeonAccordionVariantProps>(props: Props): [AeonAccordionVariantProps, Pretty<DistributiveOmit<Props, keyof AeonAccordionVariantProps>>]
  getVariantProps: (props?: AeonAccordionVariantProps) => AeonAccordionVariantProps
}

/**
 * Aeon accordion — content stacks with gap (no stacked padding + margins)
 */
export declare const aeonAccordion: AeonAccordionRecipe