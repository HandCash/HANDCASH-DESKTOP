import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonClipboardVariant = {}

export type AeonClipboardVariantProps = {
  [K in keyof AeonClipboardVariant]?: ConditionalValue<AeonClipboardVariant[K]>
}

export type AeonClipboardVariantMap = RecipeVariantMap<AeonClipboardVariant>

export type AeonClipboardSlot = "root" | "trigger" | "indicator" | "status"

export type AeonClipboardRecipe = SlotRecipeRuntimeFn<AeonClipboardSlot, AeonClipboardVariantProps, AeonClipboardVariantMap>

export declare const aeonClipboard: AeonClipboardRecipe;