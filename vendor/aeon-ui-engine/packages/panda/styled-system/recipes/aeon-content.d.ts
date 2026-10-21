import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonContentVariant = {
  align?: "start" | "center"
}

export type AeonContentVariantProps = {
  [K in keyof AeonContentVariant]?: ConditionalValue<AeonContentVariant[K]>
}

export type AeonContentVariantMap = RecipeVariantMap<AeonContentVariant>

export type AeonContentSlot = "root" | "toolbar" | "body" | "pending" | "empty" | "error" | "success" | "sentinel"

export type AeonContentRecipe = SlotRecipeRuntimeFn<AeonContentSlot, AeonContentVariantProps, AeonContentVariantMap>

export declare const aeonContent: AeonContentRecipe;