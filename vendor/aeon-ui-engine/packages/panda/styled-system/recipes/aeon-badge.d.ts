import type { ConditionalValue } from '../types/system';
import type { RecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonBadgeVariant = {
  variant?: "default" | "accent" | "danger"
}

export type AeonBadgeVariantProps = {
  [K in keyof AeonBadgeVariant]?: ConditionalValue<AeonBadgeVariant[K]>
}

export type AeonBadgeVariantMap = RecipeVariantMap<AeonBadgeVariant>

export type AeonBadgeRecipe = RecipeRuntimeFn<AeonBadgeVariantProps, AeonBadgeVariantMap>

export declare const aeonBadge: AeonBadgeRecipe;