import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonPanelDefaultVariants = {
  "size": "md"
}
const aeonPanelCompoundVariants = []

const aeonPanelSlotNames = [
  [
    "group",
    "aeonPanel__group"
  ],
  [
    "root",
    "aeonPanel__root"
  ],
  [
    "trigger",
    "aeonPanel__trigger"
  ],
  [
    "label",
    "aeonPanel__label"
  ],
  [
    "content",
    "aeonPanel__content"
  ]
]
const aeonPanelSlotFns = /* @__PURE__ */ aeonPanelSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonPanelDefaultVariants, getSlotCompoundVariant(aeonPanelCompoundVariants, slotName))])

const aeonPanelFn = memo((props = {}) => {
  return Object.fromEntries(aeonPanelSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonPanelVariantKeys = [
  "size"
]
const getVariantProps = (variants) => ({ ...aeonPanelDefaultVariants, ...compact(variants) })

export const aeonPanel = /* @__PURE__ */ Object.assign(aeonPanelFn, {
  __recipe__: false,
  __name__: 'aeonPanel',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonPanelVariantKeys,
  variantMap: {
  "size": [
    "md",
    "lg"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonPanelVariantKeys)
  },
  getVariantProps
})