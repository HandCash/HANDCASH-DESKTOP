/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonFieldVariant {
  
}

type AeonFieldVariantMap = {
  [key in keyof AeonFieldVariant]: Array<AeonFieldVariant[key]>
}

type AeonFieldSlot = "root" | "label" | "control" | "textarea" | "message" | "hint"

export type AeonFieldVariantProps = {
  [key in keyof AeonFieldVariant]?: ConditionalValue<AeonFieldVariant[key]> | undefined
}

export interface AeonFieldRecipe {
  __slot: AeonFieldSlot
  __type: AeonFieldVariantProps
  (props?: AeonFieldVariantProps): Pretty<Record<AeonFieldSlot, string>>
  raw: (props?: AeonFieldVariantProps) => AeonFieldVariantProps
  variantMap: AeonFieldVariantMap
  variantKeys: Array<keyof AeonFieldVariant>
  splitVariantProps<Props extends AeonFieldVariantProps>(props: Props): [AeonFieldVariantProps, Pretty<DistributiveOmit<Props, keyof AeonFieldVariantProps>>]
  getVariantProps: (props?: AeonFieldVariantProps) => AeonFieldVariantProps
}

/**
 * Form field with orthogonal interaction, validation, and submission states
 */
export declare const aeonField: AeonFieldRecipe