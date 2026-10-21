import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonScrollVariant = {
  axis?: "y" | "x" | "both"
  maxH?: "sm" | "md" | "lg"
  maxW?: "full" | "md"
}

export type AeonScrollVariantProps = {
  [K in keyof AeonScrollVariant]?: ConditionalValue<AeonScrollVariant[K]>
}

export type AeonScrollVariantMap = RecipeVariantMap<AeonScrollVariant>

export type AeonScrollSlot = "root" | "viewport" | "content"

export type AeonScrollRecipe = SlotRecipeRuntimeFn<AeonScrollSlot, AeonScrollVariantProps, AeonScrollVariantMap>

export declare const aeonScroll: AeonScrollRecipe;