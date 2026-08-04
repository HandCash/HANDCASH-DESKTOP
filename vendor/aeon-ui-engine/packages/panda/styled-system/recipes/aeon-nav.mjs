import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonNavDefaultVariants = {
  "size": "md",
  "layout": "inline"
}
const aeonNavCompoundVariants = []

const aeonNavSlotNames = [
  [
    "root",
    "aeonNav__root"
  ],
  [
    "item",
    "aeonNav__item"
  ],
  [
    "indicator",
    "aeonNav__indicator"
  ],
  [
    "label",
    "aeonNav__label"
  ],
  [
    "icon",
    "aeonNav__icon"
  ],
  [
    "badge",
    "aeonNav__badge"
  ]
]
const aeonNavSlotFns = /* @__PURE__ */ aeonNavSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonNavDefaultVariants, getSlotCompoundVariant(aeonNavCompoundVariants, slotName))])

const aeonNavFn = memo((props = {}) => {
  return Object.fromEntries(aeonNavSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonNavVariantKeys = [
  "size",
  "layout"
]
const getVariantProps = (variants) => ({ ...aeonNavDefaultVariants, ...compact(variants) })

export const aeonNav = /* @__PURE__ */ Object.assign(aeonNavFn, {
  __recipe__: false,
  __name__: 'aeonNav',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonNavVariantKeys,
  variantMap: {
  "size": [
    "sm",
    "md",
    "lg"
  ],
  "layout": [
    "inline",
    "dock"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonNavVariantKeys)
  },
  getVariantProps
})