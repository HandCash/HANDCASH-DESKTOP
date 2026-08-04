/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonToastVariant {
  
}

type AeonToastVariantMap = {
  [key in keyof AeonToastVariant]: Array<AeonToastVariant[key]>
}

type AeonToastSlot = "viewport" | "root" | "title" | "description" | "closeTrigger"

export type AeonToastVariantProps = {
  [key in keyof AeonToastVariant]?: ConditionalValue<AeonToastVariant[key]> | undefined
}

export interface AeonToastRecipe {
  __slot: AeonToastSlot
  __type: AeonToastVariantProps
  (props?: AeonToastVariantProps): Pretty<Record<AeonToastSlot, string>>
  raw: (props?: AeonToastVariantProps) => AeonToastVariantProps
  variantMap: AeonToastVariantMap
  variantKeys: Array<keyof AeonToastVariant>
  splitVariantProps<Props extends AeonToastVariantProps>(props: Props): [AeonToastVariantProps, Pretty<DistributiveOmit<Props, keyof AeonToastVariantProps>>]
  getVariantProps: (props?: AeonToastVariantProps) => AeonToastVariantProps
}


export declare const aeonToast: AeonToastRecipe