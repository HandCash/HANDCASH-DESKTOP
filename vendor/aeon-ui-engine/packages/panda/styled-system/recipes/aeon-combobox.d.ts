import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonComboboxVariant = {}

export type AeonComboboxVariantProps = {
  [K in keyof AeonComboboxVariant]?: ConditionalValue<AeonComboboxVariant[K]>
}

export type AeonComboboxVariantMap = RecipeVariantMap<AeonComboboxVariant>

export type AeonComboboxSlot = "root" | "input" | "icon" | "content" | "item" | "empty"

export type AeonComboboxRecipe = SlotRecipeRuntimeFn<AeonComboboxSlot, AeonComboboxVariantProps, AeonComboboxVariantMap>

export declare const aeonCombobox: AeonComboboxRecipe;