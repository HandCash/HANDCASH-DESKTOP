import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonTabsVariant = {}

export type AeonTabsVariantProps = {
  [K in keyof AeonTabsVariant]?: ConditionalValue<AeonTabsVariant[K]>
}

export type AeonTabsVariantMap = RecipeVariantMap<AeonTabsVariant>

export type AeonTabsSlot = "root" | "list" | "trigger" | "content" | "indicator"

export type AeonTabsRecipe = SlotRecipeRuntimeFn<AeonTabsSlot, AeonTabsVariantProps, AeonTabsVariantMap>

export declare const aeonTabs: AeonTabsRecipe;