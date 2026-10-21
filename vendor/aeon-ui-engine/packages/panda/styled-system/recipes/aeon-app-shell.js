import { createSlotRecipe } from './runtime';

const aeonAppShellConfig = {"name":"aeonAppShell","slots":["root","header","subheader","content","aside","footer","dock","scrim"],"defaultVariants":{"contentAlign":"start"},"variantMap":{"contentAlign":["start","center"]}}

export const aeonAppShell = /* @__PURE__ */ createSlotRecipe(aeonAppShellConfig)