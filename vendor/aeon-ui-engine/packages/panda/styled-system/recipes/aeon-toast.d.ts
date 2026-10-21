import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonToastVariant = {}

export type AeonToastVariantProps = {
  [K in keyof AeonToastVariant]?: ConditionalValue<AeonToastVariant[K]>
}

export type AeonToastVariantMap = RecipeVariantMap<AeonToastVariant>

export type AeonToastSlot = "viewport" | "root" | "title" | "description" | "closeTrigger"

export type AeonToastRecipe = SlotRecipeRuntimeFn<AeonToastSlot, AeonToastVariantProps, AeonToastVariantMap>

export declare const aeonToast: AeonToastRecipe;