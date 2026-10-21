import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonMenuVariant = {}

export type AeonMenuVariantProps = {
  [K in keyof AeonMenuVariant]?: ConditionalValue<AeonMenuVariant[K]>
}

export type AeonMenuVariantMap = RecipeVariantMap<AeonMenuVariant>

export type AeonMenuSlot = "root" | "trigger" | "positioner" | "content" | "item" | "separator"

export type AeonMenuRecipe = SlotRecipeRuntimeFn<AeonMenuSlot, AeonMenuVariantProps, AeonMenuVariantMap>

export declare const aeonMenu: AeonMenuRecipe;