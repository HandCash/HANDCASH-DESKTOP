import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonIdentityDefaultVariants = {
  "size": "md"
}
const aeonIdentityCompoundVariants = []

const aeonIdentitySlotNames = [
  [
    "root",
    "aeonIdentity__root"
  ],
  [
    "avatar",
    "aeonIdentity__avatar"
  ],
  [
    "title",
    "aeonIdentity__title"
  ],
  [
    "subtitle",
    "aeonIdentity__subtitle"
  ],
  [
    "meta",
    "aeonIdentity__meta"
  ],
  [
    "trailing",
    "aeonIdentity__trailing"
  ]
]
const aeonIdentitySlotFns = /* @__PURE__ */ aeonIdentitySlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonIdentityDefaultVariants, getSlotCompoundVariant(aeonIdentityCompoundVariants, slotName))])

const aeonIdentityFn = memo((props = {}) => {
  return Object.fromEntries(aeonIdentitySlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonIdentityVariantKeys = [
  "size"
]
const getVariantProps = (variants) => ({ ...aeonIdentityDefaultVariants, ...compact(variants) })

export const aeonIdentity = /* @__PURE__ */ Object.assign(aeonIdentityFn, {
  __recipe__: false,
  __name__: 'aeonIdentity',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonIdentityVariantKeys,
  variantMap: {
  "size": [
    "sm",
    "md",
    "lg"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonIdentityVariantKeys)
  },
  getVariantProps
})