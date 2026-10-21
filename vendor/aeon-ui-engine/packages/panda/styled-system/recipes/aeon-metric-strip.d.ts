import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonMetricStripVariant = {
  density?: "cluster" | "loose"
}

export type AeonMetricStripVariantProps = {
  [K in keyof AeonMetricStripVariant]?: ConditionalValue<AeonMetricStripVariant[K]>
}

export type AeonMetricStripVariantMap = RecipeVariantMap<AeonMetricStripVariant>

export type AeonMetricStripSlot = "root" | "chip" | "value" | "label"

export type AeonMetricStripRecipe = SlotRecipeRuntimeFn<AeonMetricStripSlot, AeonMetricStripVariantProps, AeonMetricStripVariantMap>

export declare const aeonMetricStrip: AeonMetricStripRecipe;