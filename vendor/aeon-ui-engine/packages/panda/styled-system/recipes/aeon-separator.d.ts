import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonSeparatorVariant = {
  orientation?: "horizontal" | "vertical"
}

export type AeonSeparatorVariantProps = {
  [K in keyof AeonSeparatorVariant]?: ConditionalValue<AeonSeparatorVariant[K]>
}

export type AeonSeparatorVariantMap = RecipeVariantMap<AeonSeparatorVariant>

export type AeonSeparatorSlot = "root"

export type AeonSeparatorRecipe = SlotRecipeRuntimeFn<AeonSeparatorSlot, AeonSeparatorVariantProps, AeonSeparatorVariantMap>

export declare const aeonSeparator: AeonSeparatorRecipe;