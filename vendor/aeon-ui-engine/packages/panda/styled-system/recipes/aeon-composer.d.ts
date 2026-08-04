/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonComposerVariant {
  
}

type AeonComposerVariantMap = {
  [key in keyof AeonComposerVariant]: Array<AeonComposerVariant[key]>
}

type AeonComposerSlot = "root" | "input" | "actions" | "send" | "suggestions" | "suggestion" | "toolbar"

export type AeonComposerVariantProps = {
  [key in keyof AeonComposerVariant]?: ConditionalValue<AeonComposerVariant[key]> | undefined
}

export interface AeonComposerRecipe {
  __slot: AeonComposerSlot
  __type: AeonComposerVariantProps
  (props?: AeonComposerVariantProps): Pretty<Record<AeonComposerSlot, string>>
  raw: (props?: AeonComposerVariantProps) => AeonComposerVariantProps
  variantMap: AeonComposerVariantMap
  variantKeys: Array<keyof AeonComposerVariant>
  splitVariantProps<Props extends AeonComposerVariantProps>(props: Props): [AeonComposerVariantProps, Pretty<DistributiveOmit<Props, keyof AeonComposerVariantProps>>]
  getVariantProps: (props?: AeonComposerVariantProps) => AeonComposerVariantProps
}


export declare const aeonComposer: AeonComposerRecipe