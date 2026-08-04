import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonRadioGroupDefaultVariants = {}
const aeonRadioGroupCompoundVariants = []

const aeonRadioGroupSlotNames = [
  [
    "root",
    "aeonRadioGroup__root"
  ],
  [
    "item",
    "aeonRadioGroup__item"
  ],
  [
    "itemControl",
    "aeonRadioGroup__itemControl"
  ],
  [
    "itemIndicator",
    "aeonRadioGroup__itemIndicator"
  ],
  [
    "itemLabel",
    "aeonRadioGroup__itemLabel"
  ]
]
const aeonRadioGroupSlotFns = /* @__PURE__ */ aeonRadioGroupSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonRadioGroupDefaultVariants, getSlotCompoundVariant(aeonRadioGroupCompoundVariants, slotName))])

const aeonRadioGroupFn = memo((props = {}) => {
  return Object.fromEntries(aeonRadioGroupSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonRadioGroupVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonRadioGroupDefaultVariants, ...compact(variants) })

export const aeonRadioGroup = /* @__PURE__ */ Object.assign(aeonRadioGroupFn, {
  __recipe__: false,
  __name__: 'aeonRadioGroup',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonRadioGroupVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonRadioGroupVariantKeys)
  },
  getVariantProps
})