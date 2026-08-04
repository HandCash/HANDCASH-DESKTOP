import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonSelectDefaultVariants = {}
const aeonSelectCompoundVariants = []

const aeonSelectSlotNames = [
  [
    "root",
    "aeonSelect__root"
  ],
  [
    "trigger",
    "aeonSelect__trigger"
  ],
  [
    "value",
    "aeonSelect__value"
  ],
  [
    "icon",
    "aeonSelect__icon"
  ],
  [
    "positioner",
    "aeonSelect__positioner"
  ],
  [
    "content",
    "aeonSelect__content"
  ],
  [
    "item",
    "aeonSelect__item"
  ]
]
const aeonSelectSlotFns = /* @__PURE__ */ aeonSelectSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonSelectDefaultVariants, getSlotCompoundVariant(aeonSelectCompoundVariants, slotName))])

const aeonSelectFn = memo((props = {}) => {
  return Object.fromEntries(aeonSelectSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonSelectVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonSelectDefaultVariants, ...compact(variants) })

export const aeonSelect = /* @__PURE__ */ Object.assign(aeonSelectFn, {
  __recipe__: false,
  __name__: 'aeonSelect',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonSelectVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonSelectVariantKeys)
  },
  getVariantProps
})