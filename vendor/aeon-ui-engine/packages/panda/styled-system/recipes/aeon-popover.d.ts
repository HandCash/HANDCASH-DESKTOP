import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonPopoverVariant = {}

export type AeonPopoverVariantProps = {
  [K in keyof AeonPopoverVariant]?: ConditionalValue<AeonPopoverVariant[K]>
}

export type AeonPopoverVariantMap = RecipeVariantMap<AeonPopoverVariant>

export type AeonPopoverSlot = "root" | "trigger" | "positioner" | "content" | "arrow" | "closeTrigger"

export type AeonPopoverRecipe = SlotRecipeRuntimeFn<AeonPopoverSlot, AeonPopoverVariantProps, AeonPopoverVariantMap>

export declare const aeonPopover: AeonPopoverRecipe;