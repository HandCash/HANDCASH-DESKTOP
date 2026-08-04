import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonAsyncDefaultVariants = {}
const aeonAsyncCompoundVariants = []

const aeonAsyncSlotNames = [
  [
    "root",
    "aeonAsync__root"
  ],
  [
    "track",
    "aeonAsync__track"
  ],
  [
    "segment",
    "aeonAsync__segment"
  ],
  [
    "readout",
    "aeonAsync__readout"
  ],
  [
    "readoutRail",
    "aeonAsync__readoutRail"
  ],
  [
    "readoutBody",
    "aeonAsync__readoutBody"
  ],
  [
    "actions",
    "aeonAsync__actions"
  ]
]
const aeonAsyncSlotFns = /* @__PURE__ */ aeonAsyncSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonAsyncDefaultVariants, getSlotCompoundVariant(aeonAsyncCompoundVariants, slotName))])

const aeonAsyncFn = memo((props = {}) => {
  return Object.fromEntries(aeonAsyncSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonAsyncVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonAsyncDefaultVariants, ...compact(variants) })

export const aeonAsync = /* @__PURE__ */ Object.assign(aeonAsyncFn, {
  __recipe__: false,
  __name__: 'aeonAsync',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonAsyncVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonAsyncVariantKeys)
  },
  getVariantProps
})