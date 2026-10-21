import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonFileUploadVariant = {}

export type AeonFileUploadVariantProps = {
  [K in keyof AeonFileUploadVariant]?: ConditionalValue<AeonFileUploadVariant[K]>
}

export type AeonFileUploadVariantMap = RecipeVariantMap<AeonFileUploadVariant>

export type AeonFileUploadSlot = "root" | "dropzone" | "input" | "label" | "hint" | "preview" | "clearTrigger" | "rejectionMessage"

export type AeonFileUploadRecipe = SlotRecipeRuntimeFn<AeonFileUploadSlot, AeonFileUploadVariantProps, AeonFileUploadVariantMap>

export declare const aeonFileUpload: AeonFileUploadRecipe;