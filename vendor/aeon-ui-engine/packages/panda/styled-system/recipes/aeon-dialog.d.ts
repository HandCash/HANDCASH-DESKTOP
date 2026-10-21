import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonDialogVariant = {}

export type AeonDialogVariantProps = {
  [K in keyof AeonDialogVariant]?: ConditionalValue<AeonDialogVariant[K]>
}

export type AeonDialogVariantMap = RecipeVariantMap<AeonDialogVariant>

export type AeonDialogSlot = "root" | "trigger" | "backdrop" | "positioner" | "content" | "title" | "description" | "closeTrigger"

export type AeonDialogRecipe = SlotRecipeRuntimeFn<AeonDialogSlot, AeonDialogVariantProps, AeonDialogVariantMap>

export declare const aeonDialog: AeonDialogRecipe;