import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonBarVariant = {
  size?: "xs" | "sm" | "md" | "lg"
  sticky?: boolean
  placement?: "top" | "bottom" | "inline"
  collapse?: "shrink" | "wrap" | "collapse-center"
}

export type AeonBarVariantProps = {
  [K in keyof AeonBarVariant]?: ConditionalValue<AeonBarVariant[K]>
}

export type AeonBarVariantMap = RecipeVariantMap<AeonBarVariant>

export type AeonBarSlot = "root" | "leading" | "center" | "trailing" | "seam"

export type AeonBarRecipe = SlotRecipeRuntimeFn<AeonBarSlot, AeonBarVariantProps, AeonBarVariantMap>

export declare const aeonBar: AeonBarRecipe;