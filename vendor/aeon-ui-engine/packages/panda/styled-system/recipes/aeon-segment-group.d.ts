import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonSegmentGroupVariant = {
  size?: "sm" | "md"
}

export type AeonSegmentGroupVariantProps = {
  [K in keyof AeonSegmentGroupVariant]?: ConditionalValue<AeonSegmentGroupVariant[K]>
}

export type AeonSegmentGroupVariantMap = RecipeVariantMap<AeonSegmentGroupVariant>

export type AeonSegmentGroupSlot = "root" | "item"

export type AeonSegmentGroupRecipe = SlotRecipeRuntimeFn<AeonSegmentGroupSlot, AeonSegmentGroupVariantProps, AeonSegmentGroupVariantMap>

export declare const aeonSegmentGroup: AeonSegmentGroupRecipe;