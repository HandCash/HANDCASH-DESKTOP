/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonAppShellVariant {
  /**
 * @default "start"
 */
contentAlign: "start" | "center"
}

type AeonAppShellVariantMap = {
  [key in keyof AeonAppShellVariant]: Array<AeonAppShellVariant[key]>
}

type AeonAppShellSlot = "root" | "header" | "subheader" | "content" | "aside" | "footer" | "dock" | "scrim"

export type AeonAppShellVariantProps = {
  [key in keyof AeonAppShellVariant]?: ConditionalValue<AeonAppShellVariant[key]> | undefined
}

export interface AeonAppShellRecipe {
  __slot: AeonAppShellSlot
  __type: AeonAppShellVariantProps
  (props?: AeonAppShellVariantProps): Pretty<Record<AeonAppShellSlot, string>>
  raw: (props?: AeonAppShellVariantProps) => AeonAppShellVariantProps
  variantMap: AeonAppShellVariantMap
  variantKeys: Array<keyof AeonAppShellVariant>
  splitVariantProps<Props extends AeonAppShellVariantProps>(props: Props): [AeonAppShellVariantProps, Pretty<DistributiveOmit<Props, keyof AeonAppShellVariantProps>>]
  getVariantProps: (props?: AeonAppShellVariantProps) => AeonAppShellVariantProps
}


export declare const aeonAppShell: AeonAppShellRecipe