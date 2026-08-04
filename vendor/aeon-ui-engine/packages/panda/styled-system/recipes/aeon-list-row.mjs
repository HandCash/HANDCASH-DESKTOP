import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonListRowDefaultVariants = {}
const aeonListRowCompoundVariants = []

const aeonListRowSlotNames = [
  [
    "root",
    "aeonListRow__root"
  ],
  [
    "leading",
    "aeonListRow__leading"
  ],
  [
    "label",
    "aeonListRow__label"
  ],
  [
    "description",
    "aeonListRow__description"
  ],
  [
    "trailing",
    "aeonListRow__trailing"
  ]
]
const aeonListRowSlotFns = /* @__PURE__ */ aeonListRowSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonListRowDefaultVariants, getSlotCompoundVariant(aeonListRowCompoundVariants, slotName))])

const aeonListRowFn = memo((props = {}) => {
  return Object.fromEntries(aeonListRowSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonListRowVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonListRowDefaultVariants, ...compact(variants) })

export const aeonListRow = /* @__PURE__ */ Object.assign(aeonListRowFn, {
  __recipe__: false,
  __name__: 'aeonListRow',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonListRowVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonListRowVariantKeys)
  },
  getVariantProps
})