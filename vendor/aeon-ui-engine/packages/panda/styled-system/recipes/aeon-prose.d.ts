import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonProseVariant = {}

export type AeonProseVariantProps = {
  [K in keyof AeonProseVariant]?: ConditionalValue<AeonProseVariant[K]>
}

export type AeonProseVariantMap = RecipeVariantMap<AeonProseVariant>

export type AeonProseSlot = "root"

export type AeonProseRecipe = SlotRecipeRuntimeFn<AeonProseSlot, AeonProseVariantProps, AeonProseVariantMap>

export declare const aeonProse: AeonProseRecipe;