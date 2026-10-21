import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonNavVariant = {
  size?: "sm" | "md" | "lg"
  layout?: "inline" | "dock"
}

export type AeonNavVariantProps = {
  [K in keyof AeonNavVariant]?: ConditionalValue<AeonNavVariant[K]>
}

export type AeonNavVariantMap = RecipeVariantMap<AeonNavVariant>

export type AeonNavSlot = "root" | "item" | "indicator" | "label" | "icon" | "badge"

export type AeonNavRecipe = SlotRecipeRuntimeFn<AeonNavSlot, AeonNavVariantProps, AeonNavVariantMap>

export declare const aeonNav: AeonNavRecipe;