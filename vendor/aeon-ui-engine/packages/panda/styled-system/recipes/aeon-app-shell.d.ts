import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonAppShellVariant = {
  contentAlign?: "start" | "center"
}

export type AeonAppShellVariantProps = {
  [K in keyof AeonAppShellVariant]?: ConditionalValue<AeonAppShellVariant[K]>
}

export type AeonAppShellVariantMap = RecipeVariantMap<AeonAppShellVariant>

export type AeonAppShellSlot = "root" | "header" | "subheader" | "content" | "aside" | "footer" | "dock" | "scrim"

export type AeonAppShellRecipe = SlotRecipeRuntimeFn<AeonAppShellSlot, AeonAppShellVariantProps, AeonAppShellVariantMap>

export declare const aeonAppShell: AeonAppShellRecipe;