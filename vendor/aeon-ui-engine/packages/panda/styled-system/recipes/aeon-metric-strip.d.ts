/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonMetricStripVariant {
  /**
 * @default "cluster"
 */
density: "cluster" | "loose"
}

type AeonMetricStripVariantMap = {
  [key in keyof AeonMetricStripVariant]: Array<AeonMetricStripVariant[key]>
}

type AeonMetricStripSlot = "root" | "chip" | "value" | "label"

export type AeonMetricStripVariantProps = {
  [key in keyof AeonMetricStripVariant]?: ConditionalValue<AeonMetricStripVariant[key]> | undefined
}

export interface AeonMetricStripRecipe {
  __slot: AeonMetricStripSlot
  __type: AeonMetricStripVariantProps
  (props?: AeonMetricStripVariantProps): Pretty<Record<AeonMetricStripSlot, string>>
  raw: (props?: AeonMetricStripVariantProps) => AeonMetricStripVariantProps
  variantMap: AeonMetricStripVariantMap
  variantKeys: Array<keyof AeonMetricStripVariant>
  splitVariantProps<Props extends AeonMetricStripVariantProps>(props: Props): [AeonMetricStripVariantProps, Pretty<DistributiveOmit<Props, keyof AeonMetricStripVariantProps>>]
  getVariantProps: (props?: AeonMetricStripVariantProps) => AeonMetricStripVariantProps
}

/**
 * Dense metric chips — value + uppercase label
 */
export declare const aeonMetricStrip: AeonMetricStripRecipe