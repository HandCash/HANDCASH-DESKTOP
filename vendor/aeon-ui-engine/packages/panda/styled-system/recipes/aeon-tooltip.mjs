import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonTooltipDefaultVariants = {}
const aeonTooltipCompoundVariants = []

const aeonTooltipSlotNames = [
  [
    "root",
    "aeonTooltip__root"
  ],
  [
    "trigger",
    "aeonTooltip__trigger"
  ],
  [
    "positioner",
    "aeonTooltip__positioner"
  ],
  [
    "content",
    "aeonTooltip__content"
  ],
  [
    "arrow",
    "aeonTooltip__arrow"
  ]
]
const aeonTooltipSlotFns = /* @__PURE__ */ aeonTooltipSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonTooltipDefaultVariants, getSlotCompoundVariant(aeonTooltipCompoundVariants, slotName))])

const aeonTooltipFn = memo((props = {}) => {
  return Object.fromEntries(aeonTooltipSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonTooltipVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonTooltipDefaultVariants, ...compact(variants) })

export const aeonTooltip = /* @__PURE__ */ Object.assign(aeonTooltipFn, {
  __recipe__: false,
  __name__: 'aeonTooltip',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonTooltipVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonTooltipVariantKeys)
  },
  getVariantProps
})