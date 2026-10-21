import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonPanelVariant = {
  size?: "md" | "lg"
}

export type AeonPanelVariantProps = {
  [K in keyof AeonPanelVariant]?: ConditionalValue<AeonPanelVariant[K]>
}

export type AeonPanelVariantMap = RecipeVariantMap<AeonPanelVariant>

export type AeonPanelSlot = "group" | "root" | "trigger" | "label" | "content"

export type AeonPanelRecipe = SlotRecipeRuntimeFn<AeonPanelSlot, AeonPanelVariantProps, AeonPanelVariantMap>

export declare const aeonPanel: AeonPanelRecipe;