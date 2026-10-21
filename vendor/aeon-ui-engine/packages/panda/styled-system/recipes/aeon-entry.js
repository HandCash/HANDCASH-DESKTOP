import { createSlotRecipe } from './runtime';

const aeonEntryConfig = {"name":"aeonEntry","slots":["list","root","header","leading","heading","title","subtitle","meta","media","body","values","value","actions","footer"],"defaultVariants":{"density":"compact","layout":"stack"},"variantMap":{"density":["compact","cozy"],"layout":["stack","split"]}}

export const aeonEntry = /* @__PURE__ */ createSlotRecipe(aeonEntryConfig)