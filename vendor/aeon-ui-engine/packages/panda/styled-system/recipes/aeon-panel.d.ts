/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonPanelVariant {
  /**
 * @default "md"
 */
size: "md" | "lg"
}

type AeonPanelVariantMap = {
  [key in keyof AeonPanelVariant]: Array<AeonPanelVariant[key]>
}

type AeonPanelSlot = "group" | "root" | "trigger" | "label" | "content"

export type AeonPanelVariantProps = {
  [key in keyof AeonPanelVariant]?: ConditionalValue<AeonPanelVariant[key]> | undefined
}

export interface AeonPanelRecipe {
  __slot: AeonPanelSlot
  __type: AeonPanelVariantProps
  (props?: AeonPanelVariantProps): Pretty<Record<AeonPanelSlot, string>>
  raw: (props?: AeonPanelVariantProps) => AeonPanelVariantProps
  variantMap: AeonPanelVariantMap
  variantKeys: Array<keyof AeonPanelVariant>
  splitVariantProps<Props extends AeonPanelVariantProps>(props: Props): [AeonPanelVariantProps, Pretty<DistributiveOmit<Props, keyof AeonPanelVariantProps>>]
  getVariantProps: (props?: AeonPanelVariantProps) => AeonPanelVariantProps
}


export declare const aeonPanel: AeonPanelRecipe