import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonConversationDefaultVariants = {}
const aeonConversationCompoundVariants = []

const aeonConversationSlotNames = [
  [
    "root",
    "aeonConversation__root"
  ],
  [
    "item",
    "aeonConversation__item"
  ],
  [
    "leading",
    "aeonConversation__leading"
  ],
  [
    "body",
    "aeonConversation__body"
  ],
  [
    "title",
    "aeonConversation__title"
  ],
  [
    "preview",
    "aeonConversation__preview"
  ],
  [
    "meta",
    "aeonConversation__meta"
  ],
  [
    "badge",
    "aeonConversation__badge"
  ]
]
const aeonConversationSlotFns = /* @__PURE__ */ aeonConversationSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonConversationDefaultVariants, getSlotCompoundVariant(aeonConversationCompoundVariants, slotName))])

const aeonConversationFn = memo((props = {}) => {
  return Object.fromEntries(aeonConversationSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonConversationVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonConversationDefaultVariants, ...compact(variants) })

export const aeonConversation = /* @__PURE__ */ Object.assign(aeonConversationFn, {
  __recipe__: false,
  __name__: 'aeonConversation',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonConversationVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonConversationVariantKeys)
  },
  getVariantProps
})