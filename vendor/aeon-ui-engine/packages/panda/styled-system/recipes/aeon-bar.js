import { createSlotRecipe } from './runtime';

const aeonBarConfig = {"name":"aeonBar","slots":["root","leading","center","trailing","seam"],"defaultVariants":{"collapse":"shrink","size":"sm"},"variantMap":{"size":["xs","sm","md","lg"],"sticky":["true"],"placement":["top","bottom","inline"],"collapse":["shrink","wrap","collapse-center"]}}

export const aeonBar = /* @__PURE__ */ createSlotRecipe(aeonBarConfig)