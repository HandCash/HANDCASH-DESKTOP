import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonComposerVariant = {}

export type AeonComposerVariantProps = {
  [K in keyof AeonComposerVariant]?: ConditionalValue<AeonComposerVariant[K]>
}

export type AeonComposerVariantMap = RecipeVariantMap<AeonComposerVariant>

export type AeonComposerSlot = "root" | "input" | "actions" | "send" | "suggestions" | "suggestion" | "toolbar"

export type AeonComposerRecipe = SlotRecipeRuntimeFn<AeonComposerSlot, AeonComposerVariantProps, AeonComposerVariantMap>

export declare const aeonComposer: AeonComposerRecipe;