import { createSlotRecipe } from './runtime';

const aeonScrollConfig = {"name":"aeonScroll","slots":["root","viewport","content"],"defaultVariants":{"axis":"both","maxH":"md","maxW":"full"},"variantMap":{"axis":["y","x","both"],"maxH":["sm","md","lg"],"maxW":["full","md"]}}

export const aeonScroll = /* @__PURE__ */ createSlotRecipe(aeonScrollConfig)