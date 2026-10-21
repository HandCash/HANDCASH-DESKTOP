import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonThemeSwitcherVariant = {
  size?: "xs" | "sm" | "md"
}

export type AeonThemeSwitcherVariantProps = {
  [K in keyof AeonThemeSwitcherVariant]?: ConditionalValue<AeonThemeSwitcherVariant[K]>
}

export type AeonThemeSwitcherVariantMap = RecipeVariantMap<AeonThemeSwitcherVariant>

export type AeonThemeSwitcherSlot = "root" | "modes" | "modeBtn" | "themeSelect" | "themeTrigger"

export type AeonThemeSwitcherRecipe = SlotRecipeRuntimeFn<AeonThemeSwitcherSlot, AeonThemeSwitcherVariantProps, AeonThemeSwitcherVariantMap>

export declare const aeonThemeSwitcher: AeonThemeSwitcherRecipe;