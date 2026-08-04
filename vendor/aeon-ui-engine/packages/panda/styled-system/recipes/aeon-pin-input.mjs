import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonPinInputDefaultVariants = {}
const aeonPinInputCompoundVariants = []

const aeonPinInputSlotNames = [
  [
    "root",
    "aeonPinInput__root"
  ],
  [
    "input",
    "aeonPinInput__input"
  ]
]
const aeonPinInputSlotFns = /* @__PURE__ */ aeonPinInputSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonPinInputDefaultVariants, getSlotCompoundVariant(aeonPinInputCompoundVariants, slotName))])

const aeonPinInputFn = memo((props = {}) => {
  return Object.fromEntries(aeonPinInputSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonPinInputVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonPinInputDefaultVariants, ...compact(variants) })

export const aeonPinInput = /* @__PURE__ */ Object.assign(aeonPinInputFn, {
  __recipe__: false,
  __name__: 'aeonPinInput',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonPinInputVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonPinInputVariantKeys)
  },
  getVariantProps
})