/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonAsyncVariant {
  
}

type AeonAsyncVariantMap = {
  [key in keyof AeonAsyncVariant]: Array<AeonAsyncVariant[key]>
}

type AeonAsyncSlot = "root" | "track" | "segment" | "readout" | "readoutRail" | "readoutBody" | "actions"

export type AeonAsyncVariantProps = {
  [key in keyof AeonAsyncVariant]?: ConditionalValue<AeonAsyncVariant[key]> | undefined
}

export interface AeonAsyncRecipe {
  __slot: AeonAsyncSlot
  __type: AeonAsyncVariantProps
  (props?: AeonAsyncVariantProps): Pretty<Record<AeonAsyncSlot, string>>
  raw: (props?: AeonAsyncVariantProps) => AeonAsyncVariantProps
  variantMap: AeonAsyncVariantMap
  variantKeys: Array<keyof AeonAsyncVariant>
  splitVariantProps<Props extends AeonAsyncVariantProps>(props: Props): [AeonAsyncVariantProps, Pretty<DistributiveOmit<Props, keyof AeonAsyncVariantProps>>]
  getVariantProps: (props?: AeonAsyncVariantProps) => AeonAsyncVariantProps
}

/**
 * Async data region — track, readout, and actions
 */
export declare const aeonAsync: AeonAsyncRecipe