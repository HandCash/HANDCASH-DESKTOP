import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonFieldDefaultVariants = {}
const aeonFieldCompoundVariants = []

const aeonFieldSlotNames = [
  [
    "root",
    "aeonField__root"
  ],
  [
    "label",
    "aeonField__label"
  ],
  [
    "control",
    "aeonField__control"
  ],
  [
    "textarea",
    "aeonField__textarea"
  ],
  [
    "message",
    "aeonField__message"
  ],
  [
    "hint",
    "aeonField__hint"
  ]
]
const aeonFieldSlotFns = /* @__PURE__ */ aeonFieldSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonFieldDefaultVariants, getSlotCompoundVariant(aeonFieldCompoundVariants, slotName))])

const aeonFieldFn = memo((props = {}) => {
  return Object.fromEntries(aeonFieldSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonFieldVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonFieldDefaultVariants, ...compact(variants) })

export const aeonField = /* @__PURE__ */ Object.assign(aeonFieldFn, {
  __recipe__: false,
  __name__: 'aeonField',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonFieldVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonFieldVariantKeys)
  },
  getVariantProps
})