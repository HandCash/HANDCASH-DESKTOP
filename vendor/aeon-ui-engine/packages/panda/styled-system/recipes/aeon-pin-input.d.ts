/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonPinInputVariant {
  
}

type AeonPinInputVariantMap = {
  [key in keyof AeonPinInputVariant]: Array<AeonPinInputVariant[key]>
}

type AeonPinInputSlot = "root" | "input"

export type AeonPinInputVariantProps = {
  [key in keyof AeonPinInputVariant]?: ConditionalValue<AeonPinInputVariant[key]> | undefined
}

export interface AeonPinInputRecipe {
  __slot: AeonPinInputSlot
  __type: AeonPinInputVariantProps
  (props?: AeonPinInputVariantProps): Pretty<Record<AeonPinInputSlot, string>>
  raw: (props?: AeonPinInputVariantProps) => AeonPinInputVariantProps
  variantMap: AeonPinInputVariantMap
  variantKeys: Array<keyof AeonPinInputVariant>
  splitVariantProps<Props extends AeonPinInputVariantProps>(props: Props): [AeonPinInputVariantProps, Pretty<DistributiveOmit<Props, keyof AeonPinInputVariantProps>>]
  getVariantProps: (props?: AeonPinInputVariantProps) => AeonPinInputVariantProps
}


export declare const aeonPinInput: AeonPinInputRecipe