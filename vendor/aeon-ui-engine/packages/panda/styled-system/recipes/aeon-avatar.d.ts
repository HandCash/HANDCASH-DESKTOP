import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonAvatarVariant = {
  size?: "xs" | "sm" | "md" | "lg" | "xl"
}

export type AeonAvatarVariantProps = {
  [K in keyof AeonAvatarVariant]?: ConditionalValue<AeonAvatarVariant[K]>
}

export type AeonAvatarVariantMap = RecipeVariantMap<AeonAvatarVariant>

export type AeonAvatarSlot = "root" | "image" | "fallback" | "badge"

export type AeonAvatarRecipe = SlotRecipeRuntimeFn<AeonAvatarSlot, AeonAvatarVariantProps, AeonAvatarVariantMap>

export declare const aeonAvatar: AeonAvatarRecipe;