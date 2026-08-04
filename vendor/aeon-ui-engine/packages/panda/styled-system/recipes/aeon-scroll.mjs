import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonScrollDefaultVariants = {
  "axis": "both",
  "maxH": "md",
  "maxW": "full"
}
const aeonScrollCompoundVariants = []

const aeonScrollSlotNames = [
  [
    "root",
    "aeonScroll__root"
  ],
  [
    "viewport",
    "aeonScroll__viewport"
  ],
  [
    "content",
    "aeonScroll__content"
  ]
]
const aeonScrollSlotFns = /* @__PURE__ */ aeonScrollSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonScrollDefaultVariants, getSlotCompoundVariant(aeonScrollCompoundVariants, slotName))])

const aeonScrollFn = memo((props = {}) => {
  return Object.fromEntries(aeonScrollSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonScrollVariantKeys = [
  "axis",
  "maxH",
  "maxW"
]
const getVariantProps = (variants) => ({ ...aeonScrollDefaultVariants, ...compact(variants) })

export const aeonScroll = /* @__PURE__ */ Object.assign(aeonScrollFn, {
  __recipe__: false,
  __name__: 'aeonScroll',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonScrollVariantKeys,
  variantMap: {
  "axis": [
    "y",
    "x",
    "both"
  ],
  "maxH": [
    "sm",
    "md",
    "lg"
  ],
  "maxW": [
    "full",
    "md"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonScrollVariantKeys)
  },
  getVariantProps
})