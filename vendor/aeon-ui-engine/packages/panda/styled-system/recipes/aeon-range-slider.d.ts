import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonRangeSliderVariant = {}

export type AeonRangeSliderVariantProps = {
  [K in keyof AeonRangeSliderVariant]?: ConditionalValue<AeonRangeSliderVariant[K]>
}

export type AeonRangeSliderVariantMap = RecipeVariantMap<AeonRangeSliderVariant>

export type AeonRangeSliderSlot = "root" | "track" | "range" | "thumb" | "valueText"

export type AeonRangeSliderRecipe = SlotRecipeRuntimeFn<AeonRangeSliderSlot, AeonRangeSliderVariantProps, AeonRangeSliderVariantMap>

export declare const aeonRangeSlider: AeonRangeSliderRecipe;