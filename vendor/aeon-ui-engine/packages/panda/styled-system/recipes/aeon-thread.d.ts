import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonThreadVariant = {}

export type AeonThreadVariantProps = {
  [K in keyof AeonThreadVariant]?: ConditionalValue<AeonThreadVariant[K]>
}

export type AeonThreadVariantMap = RecipeVariantMap<AeonThreadVariant>

export type AeonThreadSlot = "root" | "list" | "item" | "bubble" | "meta" | "day" | "bind" | "card" | "cardTitle" | "cardBody" | "cardActions"

export type AeonThreadRecipe = SlotRecipeRuntimeFn<AeonThreadSlot, AeonThreadVariantProps, AeonThreadVariantMap>

export declare const aeonThread: AeonThreadRecipe;