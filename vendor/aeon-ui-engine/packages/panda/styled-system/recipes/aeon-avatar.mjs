import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonAvatarDefaultVariants = {
  "size": "md"
}
const aeonAvatarCompoundVariants = []

const aeonAvatarSlotNames = [
  [
    "root",
    "aeonAvatar__root"
  ],
  [
    "image",
    "aeonAvatar__image"
  ],
  [
    "fallback",
    "aeonAvatar__fallback"
  ],
  [
    "badge",
    "aeonAvatar__badge"
  ]
]
const aeonAvatarSlotFns = /* @__PURE__ */ aeonAvatarSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonAvatarDefaultVariants, getSlotCompoundVariant(aeonAvatarCompoundVariants, slotName))])

const aeonAvatarFn = memo((props = {}) => {
  return Object.fromEntries(aeonAvatarSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonAvatarVariantKeys = [
  "size"
]
const getVariantProps = (variants) => ({ ...aeonAvatarDefaultVariants, ...compact(variants) })

export const aeonAvatar = /* @__PURE__ */ Object.assign(aeonAvatarFn, {
  __recipe__: false,
  __name__: 'aeonAvatar',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonAvatarVariantKeys,
  variantMap: {
  "size": [
    "xs",
    "sm",
    "md",
    "lg",
    "xl"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonAvatarVariantKeys)
  },
  getVariantProps
})