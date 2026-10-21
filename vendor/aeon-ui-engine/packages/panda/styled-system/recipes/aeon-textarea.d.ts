import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonTextareaVariant = {
  variant?: "outline" | "ghost"
}

export type AeonTextareaVariantProps = {
  [K in keyof AeonTextareaVariant]?: ConditionalValue<AeonTextareaVariant[K]>
}

export type AeonTextareaVariantMap = RecipeVariantMap<AeonTextareaVariant>

export type AeonTextareaSlot = "root"

export type AeonTextareaRecipe = SlotRecipeRuntimeFn<AeonTextareaSlot, AeonTextareaVariantProps, AeonTextareaVariantMap>

export declare const aeonTextarea: AeonTextareaRecipe;