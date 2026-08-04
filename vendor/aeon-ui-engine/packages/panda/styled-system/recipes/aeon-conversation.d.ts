/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonConversationVariant {
  
}

type AeonConversationVariantMap = {
  [key in keyof AeonConversationVariant]: Array<AeonConversationVariant[key]>
}

type AeonConversationSlot = "root" | "item" | "leading" | "body" | "title" | "preview" | "meta" | "badge"

export type AeonConversationVariantProps = {
  [key in keyof AeonConversationVariant]?: ConditionalValue<AeonConversationVariant[key]> | undefined
}

export interface AeonConversationRecipe {
  __slot: AeonConversationSlot
  __type: AeonConversationVariantProps
  (props?: AeonConversationVariantProps): Pretty<Record<AeonConversationSlot, string>>
  raw: (props?: AeonConversationVariantProps) => AeonConversationVariantProps
  variantMap: AeonConversationVariantMap
  variantKeys: Array<keyof AeonConversationVariant>
  splitVariantProps<Props extends AeonConversationVariantProps>(props: Props): [AeonConversationVariantProps, Pretty<DistributiveOmit<Props, keyof AeonConversationVariantProps>>]
  getVariantProps: (props?: AeonConversationVariantProps) => AeonConversationVariantProps
}


export declare const aeonConversation: AeonConversationRecipe