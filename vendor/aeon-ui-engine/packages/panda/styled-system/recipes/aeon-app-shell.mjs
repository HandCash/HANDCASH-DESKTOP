import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonAppShellDefaultVariants = {
  "contentAlign": "start"
}
const aeonAppShellCompoundVariants = []

const aeonAppShellSlotNames = [
  [
    "root",
    "aeonAppShell__root"
  ],
  [
    "header",
    "aeonAppShell__header"
  ],
  [
    "subheader",
    "aeonAppShell__subheader"
  ],
  [
    "content",
    "aeonAppShell__content"
  ],
  [
    "aside",
    "aeonAppShell__aside"
  ],
  [
    "footer",
    "aeonAppShell__footer"
  ],
  [
    "dock",
    "aeonAppShell__dock"
  ],
  [
    "scrim",
    "aeonAppShell__scrim"
  ]
]
const aeonAppShellSlotFns = /* @__PURE__ */ aeonAppShellSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonAppShellDefaultVariants, getSlotCompoundVariant(aeonAppShellCompoundVariants, slotName))])

const aeonAppShellFn = memo((props = {}) => {
  return Object.fromEntries(aeonAppShellSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonAppShellVariantKeys = [
  "contentAlign"
]
const getVariantProps = (variants) => ({ ...aeonAppShellDefaultVariants, ...compact(variants) })

export const aeonAppShell = /* @__PURE__ */ Object.assign(aeonAppShellFn, {
  __recipe__: false,
  __name__: 'aeonAppShell',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonAppShellVariantKeys,
  variantMap: {
  "contentAlign": [
    "start",
    "center"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonAppShellVariantKeys)
  },
  getVariantProps
})