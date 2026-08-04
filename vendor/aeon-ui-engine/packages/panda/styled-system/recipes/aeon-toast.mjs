import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonToastDefaultVariants = {}
const aeonToastCompoundVariants = []

const aeonToastSlotNames = [
  [
    "viewport",
    "aeonToast__viewport"
  ],
  [
    "root",
    "aeonToast__root"
  ],
  [
    "title",
    "aeonToast__title"
  ],
  [
    "description",
    "aeonToast__description"
  ],
  [
    "closeTrigger",
    "aeonToast__closeTrigger"
  ]
]
const aeonToastSlotFns = /* @__PURE__ */ aeonToastSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonToastDefaultVariants, getSlotCompoundVariant(aeonToastCompoundVariants, slotName))])

const aeonToastFn = memo((props = {}) => {
  return Object.fromEntries(aeonToastSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonToastVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonToastDefaultVariants, ...compact(variants) })

export const aeonToast = /* @__PURE__ */ Object.assign(aeonToastFn, {
  __recipe__: false,
  __name__: 'aeonToast',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonToastVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonToastVariantKeys)
  },
  getVariantProps
})