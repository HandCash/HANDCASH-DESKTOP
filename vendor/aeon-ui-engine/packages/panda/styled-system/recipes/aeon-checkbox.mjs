import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonCheckboxDefaultVariants = {}
const aeonCheckboxCompoundVariants = []

const aeonCheckboxSlotNames = [
  [
    "root",
    "aeonCheckbox__root"
  ],
  [
    "control",
    "aeonCheckbox__control"
  ],
  [
    "indicator",
    "aeonCheckbox__indicator"
  ],
  [
    "label",
    "aeonCheckbox__label"
  ],
  [
    "hiddenInput",
    "aeonCheckbox__hiddenInput"
  ]
]
const aeonCheckboxSlotFns = /* @__PURE__ */ aeonCheckboxSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonCheckboxDefaultVariants, getSlotCompoundVariant(aeonCheckboxCompoundVariants, slotName))])

const aeonCheckboxFn = memo((props = {}) => {
  return Object.fromEntries(aeonCheckboxSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonCheckboxVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonCheckboxDefaultVariants, ...compact(variants) })

export const aeonCheckbox = /* @__PURE__ */ Object.assign(aeonCheckboxFn, {
  __recipe__: false,
  __name__: 'aeonCheckbox',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonCheckboxVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonCheckboxVariantKeys)
  },
  getVariantProps
})