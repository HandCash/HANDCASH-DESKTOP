import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonBarDefaultVariants = {
  "size": "sm",
  "collapse": "shrink"
}
const aeonBarCompoundVariants = []

const aeonBarSlotNames = [
  [
    "root",
    "aeonBar__root"
  ],
  [
    "leading",
    "aeonBar__leading"
  ],
  [
    "center",
    "aeonBar__center"
  ],
  [
    "trailing",
    "aeonBar__trailing"
  ],
  [
    "seam",
    "aeonBar__seam"
  ]
]
const aeonBarSlotFns = /* @__PURE__ */ aeonBarSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonBarDefaultVariants, getSlotCompoundVariant(aeonBarCompoundVariants, slotName))])

const aeonBarFn = memo((props = {}) => {
  return Object.fromEntries(aeonBarSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonBarVariantKeys = [
  "size",
  "sticky",
  "placement",
  "collapse"
]
const getVariantProps = (variants) => ({ ...aeonBarDefaultVariants, ...compact(variants) })

export const aeonBar = /* @__PURE__ */ Object.assign(aeonBarFn, {
  __recipe__: false,
  __name__: 'aeonBar',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonBarVariantKeys,
  variantMap: {
  "size": [
    "xs",
    "sm",
    "md",
    "lg"
  ],
  "sticky": [
    "true"
  ],
  "placement": [
    "top",
    "bottom",
    "inline"
  ],
  "collapse": [
    "shrink",
    "wrap",
    "collapse-center"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonBarVariantKeys)
  },
  getVariantProps
})