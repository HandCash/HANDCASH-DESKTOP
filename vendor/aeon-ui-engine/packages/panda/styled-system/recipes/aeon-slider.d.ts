import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonSliderVariant = {}

export type AeonSliderVariantProps = {
  [K in keyof AeonSliderVariant]?: ConditionalValue<AeonSliderVariant[K]>
}

export type AeonSliderVariantMap = RecipeVariantMap<AeonSliderVariant>

export type AeonSliderSlot = "root" | "track" | "range" | "thumb" | "valueText"

export type AeonSliderRecipe = SlotRecipeRuntimeFn<AeonSliderSlot, AeonSliderVariantProps, AeonSliderVariantMap>

export declare const aeonSlider: AeonSliderRecipe;