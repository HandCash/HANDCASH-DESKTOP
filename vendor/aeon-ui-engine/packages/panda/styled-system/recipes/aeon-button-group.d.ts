import type { ConditionalValue } from '../types/system';
import type { RecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonButtonGroupVariant = {
  orientation?: "horizontal" | "vertical"
  gap?: "sm" | "md" | "lg"
}

export type AeonButtonGroupVariantProps = {
  [K in keyof AeonButtonGroupVariant]?: ConditionalValue<AeonButtonGroupVariant[K]>
}

export type AeonButtonGroupVariantMap = RecipeVariantMap<AeonButtonGroupVariant>

export type AeonButtonGroupRecipe = RecipeRuntimeFn<AeonButtonGroupVariantProps, AeonButtonGroupVariantMap>

export declare const aeonButtonGroup: AeonButtonGroupRecipe;