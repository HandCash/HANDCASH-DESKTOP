import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonProfileHeaderDefaultVariants = {
  "align": "start"
}
const aeonProfileHeaderCompoundVariants = []

const aeonProfileHeaderSlotNames = [
  [
    "root",
    "aeonProfileHeader__root"
  ],
  [
    "media",
    "aeonProfileHeader__media"
  ],
  [
    "identity",
    "aeonProfileHeader__identity"
  ],
  [
    "metrics",
    "aeonProfileHeader__metrics"
  ],
  [
    "actions",
    "aeonProfileHeader__actions"
  ],
  [
    "body",
    "aeonProfileHeader__body"
  ]
]
const aeonProfileHeaderSlotFns = /* @__PURE__ */ aeonProfileHeaderSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonProfileHeaderDefaultVariants, getSlotCompoundVariant(aeonProfileHeaderCompoundVariants, slotName))])

const aeonProfileHeaderFn = memo((props = {}) => {
  return Object.fromEntries(aeonProfileHeaderSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonProfileHeaderVariantKeys = [
  "align"
]
const getVariantProps = (variants) => ({ ...aeonProfileHeaderDefaultVariants, ...compact(variants) })

export const aeonProfileHeader = /* @__PURE__ */ Object.assign(aeonProfileHeaderFn, {
  __recipe__: false,
  __name__: 'aeonProfileHeader',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonProfileHeaderVariantKeys,
  variantMap: {
  "align": [
    "start",
    "center"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonProfileHeaderVariantKeys)
  },
  getVariantProps
})