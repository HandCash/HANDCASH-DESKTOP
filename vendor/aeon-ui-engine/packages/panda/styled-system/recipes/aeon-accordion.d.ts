import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonAccordionVariant = {}

export type AeonAccordionVariantProps = {
  [K in keyof AeonAccordionVariant]?: ConditionalValue<AeonAccordionVariant[K]>
}

export type AeonAccordionVariantMap = RecipeVariantMap<AeonAccordionVariant>

export type AeonAccordionSlot = "root" | "item" | "itemTrigger" | "itemContent" | "itemIndicator"

export type AeonAccordionRecipe = SlotRecipeRuntimeFn<AeonAccordionSlot, AeonAccordionVariantProps, AeonAccordionVariantMap>

export declare const aeonAccordion: AeonAccordionRecipe;