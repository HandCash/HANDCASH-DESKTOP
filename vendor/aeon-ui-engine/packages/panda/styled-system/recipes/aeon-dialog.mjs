import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonDialogDefaultVariants = {}
const aeonDialogCompoundVariants = []

const aeonDialogSlotNames = [
  [
    "root",
    "aeonDialog__root"
  ],
  [
    "trigger",
    "aeonDialog__trigger"
  ],
  [
    "backdrop",
    "aeonDialog__backdrop"
  ],
  [
    "positioner",
    "aeonDialog__positioner"
  ],
  [
    "content",
    "aeonDialog__content"
  ],
  [
    "title",
    "aeonDialog__title"
  ],
  [
    "description",
    "aeonDialog__description"
  ],
  [
    "closeTrigger",
    "aeonDialog__closeTrigger"
  ]
]
const aeonDialogSlotFns = /* @__PURE__ */ aeonDialogSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonDialogDefaultVariants, getSlotCompoundVariant(aeonDialogCompoundVariants, slotName))])

const aeonDialogFn = memo((props = {}) => {
  return Object.fromEntries(aeonDialogSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonDialogVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonDialogDefaultVariants, ...compact(variants) })

export const aeonDialog = /* @__PURE__ */ Object.assign(aeonDialogFn, {
  __recipe__: false,
  __name__: 'aeonDialog',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonDialogVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonDialogVariantKeys)
  },
  getVariantProps
})