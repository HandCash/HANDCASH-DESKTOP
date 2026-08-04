import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonMenuDefaultVariants = {}
const aeonMenuCompoundVariants = []

const aeonMenuSlotNames = [
  [
    "root",
    "aeonMenu__root"
  ],
  [
    "trigger",
    "aeonMenu__trigger"
  ],
  [
    "positioner",
    "aeonMenu__positioner"
  ],
  [
    "content",
    "aeonMenu__content"
  ],
  [
    "item",
    "aeonMenu__item"
  ],
  [
    "separator",
    "aeonMenu__separator"
  ]
]
const aeonMenuSlotFns = /* @__PURE__ */ aeonMenuSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonMenuDefaultVariants, getSlotCompoundVariant(aeonMenuCompoundVariants, slotName))])

const aeonMenuFn = memo((props = {}) => {
  return Object.fromEntries(aeonMenuSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonMenuVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonMenuDefaultVariants, ...compact(variants) })

export const aeonMenu = /* @__PURE__ */ Object.assign(aeonMenuFn, {
  __recipe__: false,
  __name__: 'aeonMenu',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonMenuVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonMenuVariantKeys)
  },
  getVariantProps
})