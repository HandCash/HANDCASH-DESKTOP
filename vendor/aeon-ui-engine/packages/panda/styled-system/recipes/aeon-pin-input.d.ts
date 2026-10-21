import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonPinInputVariant = {}

export type AeonPinInputVariantProps = {
  [K in keyof AeonPinInputVariant]?: ConditionalValue<AeonPinInputVariant[K]>
}

export type AeonPinInputVariantMap = RecipeVariantMap<AeonPinInputVariant>

export type AeonPinInputSlot = "root" | "input"

export type AeonPinInputRecipe = SlotRecipeRuntimeFn<AeonPinInputSlot, AeonPinInputVariantProps, AeonPinInputVariantMap>

export declare const aeonPinInput: AeonPinInputRecipe;