import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonRadioGroupVariant = {}

export type AeonRadioGroupVariantProps = {
  [K in keyof AeonRadioGroupVariant]?: ConditionalValue<AeonRadioGroupVariant[K]>
}

export type AeonRadioGroupVariantMap = RecipeVariantMap<AeonRadioGroupVariant>

export type AeonRadioGroupSlot = "root" | "item" | "itemControl" | "itemIndicator" | "itemLabel"

export type AeonRadioGroupRecipe = SlotRecipeRuntimeFn<AeonRadioGroupSlot, AeonRadioGroupVariantProps, AeonRadioGroupVariantMap>

export declare const aeonRadioGroup: AeonRadioGroupRecipe;