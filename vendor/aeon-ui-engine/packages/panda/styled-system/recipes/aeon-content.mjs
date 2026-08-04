import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonContentDefaultVariants = {
  "align": "start"
}
const aeonContentCompoundVariants = []

const aeonContentSlotNames = [
  [
    "root",
    "aeonContent__root"
  ],
  [
    "toolbar",
    "aeonContent__toolbar"
  ],
  [
    "body",
    "aeonContent__body"
  ],
  [
    "pending",
    "aeonContent__pending"
  ],
  [
    "empty",
    "aeonContent__empty"
  ],
  [
    "error",
    "aeonContent__error"
  ],
  [
    "success",
    "aeonContent__success"
  ],
  [
    "sentinel",
    "aeonContent__sentinel"
  ]
]
const aeonContentSlotFns = /* @__PURE__ */ aeonContentSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonContentDefaultVariants, getSlotCompoundVariant(aeonContentCompoundVariants, slotName))])

const aeonContentFn = memo((props = {}) => {
  return Object.fromEntries(aeonContentSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonContentVariantKeys = [
  "align"
]
const getVariantProps = (variants) => ({ ...aeonContentDefaultVariants, ...compact(variants) })

export const aeonContent = /* @__PURE__ */ Object.assign(aeonContentFn, {
  __recipe__: false,
  __name__: 'aeonContent',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonContentVariantKeys,
  variantMap: {
  "align": [
    "start",
    "center"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonContentVariantKeys)
  },
  getVariantProps
})