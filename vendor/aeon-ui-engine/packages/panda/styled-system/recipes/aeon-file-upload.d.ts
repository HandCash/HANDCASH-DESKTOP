/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonFileUploadVariant {
  
}

type AeonFileUploadVariantMap = {
  [key in keyof AeonFileUploadVariant]: Array<AeonFileUploadVariant[key]>
}

type AeonFileUploadSlot = "root" | "dropzone" | "input" | "label" | "hint" | "preview" | "clearTrigger" | "rejectionMessage"

export type AeonFileUploadVariantProps = {
  [key in keyof AeonFileUploadVariant]?: ConditionalValue<AeonFileUploadVariant[key]> | undefined
}

export interface AeonFileUploadRecipe {
  __slot: AeonFileUploadSlot
  __type: AeonFileUploadVariantProps
  (props?: AeonFileUploadVariantProps): Pretty<Record<AeonFileUploadSlot, string>>
  raw: (props?: AeonFileUploadVariantProps) => AeonFileUploadVariantProps
  variantMap: AeonFileUploadVariantMap
  variantKeys: Array<keyof AeonFileUploadVariant>
  splitVariantProps<Props extends AeonFileUploadVariantProps>(props: Props): [AeonFileUploadVariantProps, Pretty<DistributiveOmit<Props, keyof AeonFileUploadVariantProps>>]
  getVariantProps: (props?: AeonFileUploadVariantProps) => AeonFileUploadVariantProps
}


export declare const aeonFileUpload: AeonFileUploadRecipe