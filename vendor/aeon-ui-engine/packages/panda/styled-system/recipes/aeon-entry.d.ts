/* eslint-disable */
import type { ConditionalValue } from '../types/index';
import type { DistributiveOmit, Pretty } from '../types/system-types';

interface AeonEntryVariant {
  /**
 * @default "compact"
 */
density: "compact" | "cozy"
/**
 * @default "stack"
 */
layout: "stack" | "split"
}

type AeonEntryVariantMap = {
  [key in keyof AeonEntryVariant]: Array<AeonEntryVariant[key]>
}

type AeonEntrySlot = "list" | "root" | "header" | "leading" | "heading" | "title" | "subtitle" | "meta" | "media" | "body" | "values" | "value" | "actions" | "footer"

export type AeonEntryVariantProps = {
  [key in keyof AeonEntryVariant]?: ConditionalValue<AeonEntryVariant[key]> | undefined
}

export interface AeonEntryRecipe {
  __slot: AeonEntrySlot
  __type: AeonEntryVariantProps
  (props?: AeonEntryVariantProps): Pretty<Record<AeonEntrySlot, string>>
  raw: (props?: AeonEntryVariantProps) => AeonEntryVariantProps
  variantMap: AeonEntryVariantMap
  variantKeys: Array<keyof AeonEntryVariant>
  splitVariantProps<Props extends AeonEntryVariantProps>(props: Props): [AeonEntryVariantProps, Pretty<DistributiveOmit<Props, keyof AeonEntryVariantProps>>]
  getVariantProps: (props?: AeonEntryVariantProps) => AeonEntryVariantProps
}


export declare const aeonEntry: AeonEntryRecipe