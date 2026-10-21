import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonSelectVariant = {}

export type AeonSelectVariantProps = {
  [K in keyof AeonSelectVariant]?: ConditionalValue<AeonSelectVariant[K]>
}

export type AeonSelectVariantMap = RecipeVariantMap<AeonSelectVariant>

export type AeonSelectSlot = "root" | "trigger" | "value" | "icon" | "positioner" | "content" | "item"

export type AeonSelectRecipe = SlotRecipeRuntimeFn<AeonSelectSlot, AeonSelectVariantProps, AeonSelectVariantMap>

export declare const aeonSelect: AeonSelectRecipe;