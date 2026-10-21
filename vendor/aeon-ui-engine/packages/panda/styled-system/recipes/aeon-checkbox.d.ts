import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonCheckboxVariant = {}

export type AeonCheckboxVariantProps = {
  [K in keyof AeonCheckboxVariant]?: ConditionalValue<AeonCheckboxVariant[K]>
}

export type AeonCheckboxVariantMap = RecipeVariantMap<AeonCheckboxVariant>

export type AeonCheckboxSlot = "root" | "control" | "indicator" | "label" | "hiddenInput"

export type AeonCheckboxRecipe = SlotRecipeRuntimeFn<AeonCheckboxSlot, AeonCheckboxVariantProps, AeonCheckboxVariantMap>

export declare const aeonCheckbox: AeonCheckboxRecipe;