/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonSwitchVariant {
  
}

type AeonSwitchVariantMap = {
  [key in keyof AeonSwitchVariant]: Array<AeonSwitchVariant[key]>
}

type AeonSwitchSlot = "root" | "control" | "thumb" | "label" | "hiddenInput"

export type AeonSwitchVariantProps = {
  [key in keyof AeonSwitchVariant]?: ConditionalValue<AeonSwitchVariant[key]> | undefined
}

export interface AeonSwitchRecipe {
  __slot: AeonSwitchSlot
  __type: AeonSwitchVariantProps
  (props?: AeonSwitchVariantProps): Pretty<Record<AeonSwitchSlot, string>>
  raw: (props?: AeonSwitchVariantProps) => AeonSwitchVariantProps
  variantMap: AeonSwitchVariantMap
  variantKeys: Array<keyof AeonSwitchVariant>
  splitVariantProps<Props extends AeonSwitchVariantProps>(props: Props): [AeonSwitchVariantProps, Pretty<DistributiveOmit<Props, keyof AeonSwitchVariantProps>>]
  getVariantProps: (props?: AeonSwitchVariantProps) => AeonSwitchVariantProps
}


export declare const aeonSwitch: AeonSwitchRecipe