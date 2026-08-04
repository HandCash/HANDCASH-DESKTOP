/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonProfileHeaderVariant {
  /**
 * @default "start"
 */
align: "start" | "center"
}

type AeonProfileHeaderVariantMap = {
  [key in keyof AeonProfileHeaderVariant]: Array<AeonProfileHeaderVariant[key]>
}

type AeonProfileHeaderSlot = "root" | "media" | "identity" | "metrics" | "actions" | "body"

export type AeonProfileHeaderVariantProps = {
  [key in keyof AeonProfileHeaderVariant]?: ConditionalValue<AeonProfileHeaderVariant[key]> | undefined
}

export interface AeonProfileHeaderRecipe {
  __slot: AeonProfileHeaderSlot
  __type: AeonProfileHeaderVariantProps
  (props?: AeonProfileHeaderVariantProps): Pretty<Record<AeonProfileHeaderSlot, string>>
  raw: (props?: AeonProfileHeaderVariantProps) => AeonProfileHeaderVariantProps
  variantMap: AeonProfileHeaderVariantMap
  variantKeys: Array<keyof AeonProfileHeaderVariant>
  splitVariantProps<Props extends AeonProfileHeaderVariantProps>(props: Props): [AeonProfileHeaderVariantProps, Pretty<DistributiveOmit<Props, keyof AeonProfileHeaderVariantProps>>]
  getVariantProps: (props?: AeonProfileHeaderVariantProps) => AeonProfileHeaderVariantProps
}

/**
 * Dense profile / account header — maximize horizontal real estate
 */
export declare const aeonProfileHeader: AeonProfileHeaderRecipe