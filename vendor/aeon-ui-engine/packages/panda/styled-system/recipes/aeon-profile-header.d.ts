import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonProfileHeaderVariant = {
  align?: "start" | "center"
}

export type AeonProfileHeaderVariantProps = {
  [K in keyof AeonProfileHeaderVariant]?: ConditionalValue<AeonProfileHeaderVariant[K]>
}

export type AeonProfileHeaderVariantMap = RecipeVariantMap<AeonProfileHeaderVariant>

export type AeonProfileHeaderSlot = "root" | "media" | "identity" | "metrics" | "actions" | "body"

export type AeonProfileHeaderRecipe = SlotRecipeRuntimeFn<AeonProfileHeaderSlot, AeonProfileHeaderVariantProps, AeonProfileHeaderVariantMap>

export declare const aeonProfileHeader: AeonProfileHeaderRecipe;