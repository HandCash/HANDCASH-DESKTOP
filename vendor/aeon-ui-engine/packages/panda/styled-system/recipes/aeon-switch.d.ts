import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonSwitchVariant = {}

export type AeonSwitchVariantProps = {
  [K in keyof AeonSwitchVariant]?: ConditionalValue<AeonSwitchVariant[K]>
}

export type AeonSwitchVariantMap = RecipeVariantMap<AeonSwitchVariant>

export type AeonSwitchSlot = "root" | "control" | "thumb" | "label" | "hiddenInput"

export type AeonSwitchRecipe = SlotRecipeRuntimeFn<AeonSwitchSlot, AeonSwitchVariantProps, AeonSwitchVariantMap>

export declare const aeonSwitch: AeonSwitchRecipe;