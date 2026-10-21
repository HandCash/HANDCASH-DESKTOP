import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonFieldVariant = {}

export type AeonFieldVariantProps = {
  [K in keyof AeonFieldVariant]?: ConditionalValue<AeonFieldVariant[K]>
}

export type AeonFieldVariantMap = RecipeVariantMap<AeonFieldVariant>

export type AeonFieldSlot = "root" | "label" | "control" | "textarea" | "message" | "hint"

export type AeonFieldRecipe = SlotRecipeRuntimeFn<AeonFieldSlot, AeonFieldVariantProps, AeonFieldVariantMap>

export declare const aeonField: AeonFieldRecipe;