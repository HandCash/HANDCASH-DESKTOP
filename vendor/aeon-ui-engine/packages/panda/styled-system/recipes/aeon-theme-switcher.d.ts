/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonThemeSwitcherVariant {
  /**
 * @default "sm"
 */
size: "xs" | "sm" | "md"
}

type AeonThemeSwitcherVariantMap = {
  [key in keyof AeonThemeSwitcherVariant]: Array<AeonThemeSwitcherVariant[key]>
}

type AeonThemeSwitcherSlot = "root" | "modes" | "modeBtn" | "themeSelect" | "themeTrigger"

export type AeonThemeSwitcherVariantProps = {
  [key in keyof AeonThemeSwitcherVariant]?: ConditionalValue<AeonThemeSwitcherVariant[key]> | undefined
}

export interface AeonThemeSwitcherRecipe {
  __slot: AeonThemeSwitcherSlot
  __type: AeonThemeSwitcherVariantProps
  (props?: AeonThemeSwitcherVariantProps): Pretty<Record<AeonThemeSwitcherSlot, string>>
  raw: (props?: AeonThemeSwitcherVariantProps) => AeonThemeSwitcherVariantProps
  variantMap: AeonThemeSwitcherVariantMap
  variantKeys: Array<keyof AeonThemeSwitcherVariant>
  splitVariantProps<Props extends AeonThemeSwitcherVariantProps>(props: Props): [AeonThemeSwitcherVariantProps, Pretty<DistributiveOmit<Props, keyof AeonThemeSwitcherVariantProps>>]
  getVariantProps: (props?: AeonThemeSwitcherVariantProps) => AeonThemeSwitcherVariantProps
}


export declare const aeonThemeSwitcher: AeonThemeSwitcherRecipe