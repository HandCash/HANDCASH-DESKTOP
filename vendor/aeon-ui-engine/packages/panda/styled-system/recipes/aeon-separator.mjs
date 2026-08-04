import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonSeparatorDefaultVariants = {
  "orientation": "horizontal"
}
const aeonSeparatorCompoundVariants = []

const aeonSeparatorSlotNames = [
  [
    "root",
    "aeonSeparator__root"
  ]
]
const aeonSeparatorSlotFns = /* @__PURE__ */ aeonSeparatorSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonSeparatorDefaultVariants, getSlotCompoundVariant(aeonSeparatorCompoundVariants, slotName))])

const aeonSeparatorFn = memo((props = {}) => {
  return Object.fromEntries(aeonSeparatorSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonSeparatorVariantKeys = [
  "orientation"
]
const getVariantProps = (variants) => ({ ...aeonSeparatorDefaultVariants, ...compact(variants) })

export const aeonSeparator = /* @__PURE__ */ Object.assign(aeonSeparatorFn, {
  __recipe__: false,
  __name__: 'aeonSeparator',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonSeparatorVariantKeys,
  variantMap: {
  "orientation": [
    "horizontal",
    "vertical"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonSeparatorVariantKeys)
  },
  getVariantProps
})