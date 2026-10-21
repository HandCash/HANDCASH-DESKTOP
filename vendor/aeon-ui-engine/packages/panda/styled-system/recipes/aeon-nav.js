import { createSlotRecipe } from './runtime';

const aeonNavConfig = {"name":"aeonNav","slots":["root","item","indicator","label","icon","badge"],"defaultVariants":{"layout":"inline","size":"md"},"variantMap":{"size":["sm","md","lg"],"layout":["inline","dock"]}}

export const aeonNav = /* @__PURE__ */ createSlotRecipe(aeonNavConfig)