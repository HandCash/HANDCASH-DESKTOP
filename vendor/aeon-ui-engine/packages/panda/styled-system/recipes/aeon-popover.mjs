import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonPopoverDefaultVariants = {}
const aeonPopoverCompoundVariants = []

const aeonPopoverSlotNames = [
  [
    "root",
    "aeonPopover__root"
  ],
  [
    "trigger",
    "aeonPopover__trigger"
  ],
  [
    "positioner",
    "aeonPopover__positioner"
  ],
  [
    "content",
    "aeonPopover__content"
  ],
  [
    "arrow",
    "aeonPopover__arrow"
  ],
  [
    "closeTrigger",
    "aeonPopover__closeTrigger"
  ]
]
const aeonPopoverSlotFns = /* @__PURE__ */ aeonPopoverSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonPopoverDefaultVariants, getSlotCompoundVariant(aeonPopoverCompoundVariants, slotName))])

const aeonPopoverFn = memo((props = {}) => {
  return Object.fromEntries(aeonPopoverSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonPopoverVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonPopoverDefaultVariants, ...compact(variants) })

export const aeonPopover = /* @__PURE__ */ Object.assign(aeonPopoverFn, {
  __recipe__: false,
  __name__: 'aeonPopover',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonPopoverVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonPopoverVariantKeys)
  },
  getVariantProps
})