import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonIdentityVariant = {
  size?: "sm" | "md" | "lg"
}

export type AeonIdentityVariantProps = {
  [K in keyof AeonIdentityVariant]?: ConditionalValue<AeonIdentityVariant[K]>
}

export type AeonIdentityVariantMap = RecipeVariantMap<AeonIdentityVariant>

export type AeonIdentitySlot = "root" | "avatar" | "title" | "subtitle" | "meta" | "trailing"

export type AeonIdentityRecipe = SlotRecipeRuntimeFn<AeonIdentitySlot, AeonIdentityVariantProps, AeonIdentityVariantMap>

export declare const aeonIdentity: AeonIdentityRecipe;