import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonTooltipVariant = {}

export type AeonTooltipVariantProps = {
  [K in keyof AeonTooltipVariant]?: ConditionalValue<AeonTooltipVariant[K]>
}

export type AeonTooltipVariantMap = RecipeVariantMap<AeonTooltipVariant>

export type AeonTooltipSlot = "root" | "trigger" | "positioner" | "content" | "arrow"

export type AeonTooltipRecipe = SlotRecipeRuntimeFn<AeonTooltipSlot, AeonTooltipVariantProps, AeonTooltipVariantMap>

export declare const aeonTooltip: AeonTooltipRecipe;