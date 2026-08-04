/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonDialogVariant {
  
}

type AeonDialogVariantMap = {
  [key in keyof AeonDialogVariant]: Array<AeonDialogVariant[key]>
}

type AeonDialogSlot = "root" | "trigger" | "backdrop" | "positioner" | "content" | "title" | "description" | "closeTrigger"

export type AeonDialogVariantProps = {
  [key in keyof AeonDialogVariant]?: ConditionalValue<AeonDialogVariant[key]> | undefined
}

export interface AeonDialogRecipe {
  __slot: AeonDialogSlot
  __type: AeonDialogVariantProps
  (props?: AeonDialogVariantProps): Pretty<Record<AeonDialogSlot, string>>
  raw: (props?: AeonDialogVariantProps) => AeonDialogVariantProps
  variantMap: AeonDialogVariantMap
  variantKeys: Array<keyof AeonDialogVariant>
  splitVariantProps<Props extends AeonDialogVariantProps>(props: Props): [AeonDialogVariantProps, Pretty<DistributiveOmit<Props, keyof AeonDialogVariantProps>>]
  getVariantProps: (props?: AeonDialogVariantProps) => AeonDialogVariantProps
}


export declare const aeonDialog: AeonDialogRecipe