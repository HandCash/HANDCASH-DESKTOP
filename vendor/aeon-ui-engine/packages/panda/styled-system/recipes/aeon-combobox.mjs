import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonComboboxDefaultVariants = {}
const aeonComboboxCompoundVariants = []

const aeonComboboxSlotNames = [
  [
    "root",
    "aeonCombobox__root"
  ],
  [
    "input",
    "aeonCombobox__input"
  ],
  [
    "icon",
    "aeonCombobox__icon"
  ],
  [
    "content",
    "aeonCombobox__content"
  ],
  [
    "item",
    "aeonCombobox__item"
  ],
  [
    "empty",
    "aeonCombobox__empty"
  ]
]
const aeonComboboxSlotFns = /* @__PURE__ */ aeonComboboxSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonComboboxDefaultVariants, getSlotCompoundVariant(aeonComboboxCompoundVariants, slotName))])

const aeonComboboxFn = memo((props = {}) => {
  return Object.fromEntries(aeonComboboxSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonComboboxVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonComboboxDefaultVariants, ...compact(variants) })

export const aeonCombobox = /* @__PURE__ */ Object.assign(aeonComboboxFn, {
  __recipe__: false,
  __name__: 'aeonCombobox',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonComboboxVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonComboboxVariantKeys)
  },
  getVariantProps
})