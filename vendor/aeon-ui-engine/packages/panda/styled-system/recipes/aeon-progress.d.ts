import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonProgressVariant = {}

export type AeonProgressVariantProps = {
  [K in keyof AeonProgressVariant]?: ConditionalValue<AeonProgressVariant[K]>
}

export type AeonProgressVariantMap = RecipeVariantMap<AeonProgressVariant>

export type AeonProgressSlot = "root" | "track" | "range" | "label"

export type AeonProgressRecipe = SlotRecipeRuntimeFn<AeonProgressSlot, AeonProgressVariantProps, AeonProgressVariantMap>

export declare const aeonProgress: AeonProgressRecipe;