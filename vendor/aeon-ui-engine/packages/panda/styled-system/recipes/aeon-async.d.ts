import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonAsyncVariant = {}

export type AeonAsyncVariantProps = {
  [K in keyof AeonAsyncVariant]?: ConditionalValue<AeonAsyncVariant[K]>
}

export type AeonAsyncVariantMap = RecipeVariantMap<AeonAsyncVariant>

export type AeonAsyncSlot = "root" | "track" | "segment" | "readout" | "readoutRail" | "readoutBody" | "actions"

export type AeonAsyncRecipe = SlotRecipeRuntimeFn<AeonAsyncSlot, AeonAsyncVariantProps, AeonAsyncVariantMap>

export declare const aeonAsync: AeonAsyncRecipe;