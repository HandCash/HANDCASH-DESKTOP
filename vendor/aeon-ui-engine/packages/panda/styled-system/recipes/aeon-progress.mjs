import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonProgressDefaultVariants = {}
const aeonProgressCompoundVariants = []

const aeonProgressSlotNames = [
  [
    "root",
    "aeonProgress__root"
  ],
  [
    "track",
    "aeonProgress__track"
  ],
  [
    "range",
    "aeonProgress__range"
  ],
  [
    "label",
    "aeonProgress__label"
  ]
]
const aeonProgressSlotFns = /* @__PURE__ */ aeonProgressSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonProgressDefaultVariants, getSlotCompoundVariant(aeonProgressCompoundVariants, slotName))])

const aeonProgressFn = memo((props = {}) => {
  return Object.fromEntries(aeonProgressSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonProgressVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonProgressDefaultVariants, ...compact(variants) })

export const aeonProgress = /* @__PURE__ */ Object.assign(aeonProgressFn, {
  __recipe__: false,
  __name__: 'aeonProgress',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonProgressVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonProgressVariantKeys)
  },
  getVariantProps
})