import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonComposerDefaultVariants = {}
const aeonComposerCompoundVariants = []

const aeonComposerSlotNames = [
  [
    "root",
    "aeonComposer__root"
  ],
  [
    "input",
    "aeonComposer__input"
  ],
  [
    "actions",
    "aeonComposer__actions"
  ],
  [
    "send",
    "aeonComposer__send"
  ],
  [
    "suggestions",
    "aeonComposer__suggestions"
  ],
  [
    "suggestion",
    "aeonComposer__suggestion"
  ],
  [
    "toolbar",
    "aeonComposer__toolbar"
  ]
]
const aeonComposerSlotFns = /* @__PURE__ */ aeonComposerSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonComposerDefaultVariants, getSlotCompoundVariant(aeonComposerCompoundVariants, slotName))])

const aeonComposerFn = memo((props = {}) => {
  return Object.fromEntries(aeonComposerSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonComposerVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonComposerDefaultVariants, ...compact(variants) })

export const aeonComposer = /* @__PURE__ */ Object.assign(aeonComposerFn, {
  __recipe__: false,
  __name__: 'aeonComposer',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonComposerVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonComposerVariantKeys)
  },
  getVariantProps
})