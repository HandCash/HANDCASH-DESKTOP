import type { ConditionalValue } from '../types/system';
import type { SlotRecipeRuntimeFn, RecipeVariantMap } from '../types/recipe';

export type AeonConversationVariant = {}

export type AeonConversationVariantProps = {
  [K in keyof AeonConversationVariant]?: ConditionalValue<AeonConversationVariant[K]>
}

export type AeonConversationVariantMap = RecipeVariantMap<AeonConversationVariant>

export type AeonConversationSlot = "root" | "item" | "leading" | "body" | "title" | "preview" | "meta" | "badge"

export type AeonConversationRecipe = SlotRecipeRuntimeFn<AeonConversationSlot, AeonConversationVariantProps, AeonConversationVariantMap>

export declare const aeonConversation: AeonConversationRecipe;