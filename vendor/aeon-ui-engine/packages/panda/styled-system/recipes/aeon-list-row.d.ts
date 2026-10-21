import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonListRowVariant = {}

export type AeonListRowVariantProps = {
  [K in keyof AeonListRowVariant]?: ConditionalValue<AeonListRowVariant[K]>
}

export type AeonListRowVariantMap = RecipeVariantMap<AeonListRowVariant>

export type AeonListRowSlot = "root" | "leading" | "label" | "description" | "trailing"

export type AeonListRowRecipe = SlotRecipeRuntimeFn<AeonListRowSlot, AeonListRowVariantProps, AeonListRowVariantMap>

export declare const aeonListRow: AeonListRowRecipe;