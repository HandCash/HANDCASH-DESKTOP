import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonEntryVariant = {
  density?: "compact" | "cozy"
  layout?: "stack" | "split"
}

export type AeonEntryVariantProps = {
  [K in keyof AeonEntryVariant]?: ConditionalValue<AeonEntryVariant[K]>
}

export type AeonEntryVariantMap = RecipeVariantMap<AeonEntryVariant>

export type AeonEntrySlot = "list" | "root" | "header" | "leading" | "heading" | "title" | "subtitle" | "meta" | "media" | "body" | "values" | "value" | "actions" | "footer"

export type AeonEntryRecipe = SlotRecipeRuntimeFn<AeonEntrySlot, AeonEntryVariantProps, AeonEntryVariantMap>

export declare const aeonEntry: AeonEntryRecipe;