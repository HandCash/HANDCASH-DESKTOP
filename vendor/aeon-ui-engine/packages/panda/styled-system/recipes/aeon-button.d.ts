import type { ConditionalValue } from '../types/system';
import type { RecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonButtonVariant = {
  variant?: "solid" | "outline" | "ghost"
  size?: "xs" | "sm" | "md" | "lg"
}

export type AeonButtonVariantProps = {
  [K in keyof AeonButtonVariant]?: ConditionalValue<AeonButtonVariant[K]>
}

export type AeonButtonVariantMap = RecipeVariantMap<AeonButtonVariant>

export type AeonButtonRecipe = RecipeRuntimeFn<AeonButtonVariantProps, AeonButtonVariantMap>

export declare const aeonButton: AeonButtonRecipe;