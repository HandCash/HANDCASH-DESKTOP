import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonAccordionDefaultVariants = {}
const aeonAccordionCompoundVariants = []

const aeonAccordionSlotNames = [
  [
    "root",
    "aeonAccordion__root"
  ],
  [
    "item",
    "aeonAccordion__item"
  ],
  [
    "itemTrigger",
    "aeonAccordion__itemTrigger"
  ],
  [
    "itemContent",
    "aeonAccordion__itemContent"
  ],
  [
    "itemIndicator",
    "aeonAccordion__itemIndicator"
  ]
]
const aeonAccordionSlotFns = /* @__PURE__ */ aeonAccordionSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonAccordionDefaultVariants, getSlotCompoundVariant(aeonAccordionCompoundVariants, slotName))])

const aeonAccordionFn = memo((props = {}) => {
  return Object.fromEntries(aeonAccordionSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonAccordionVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonAccordionDefaultVariants, ...compact(variants) })

export const aeonAccordion = /* @__PURE__ */ Object.assign(aeonAccordionFn, {
  __recipe__: false,
  __name__: 'aeonAccordion',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonAccordionVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonAccordionVariantKeys)
  },
  getVariantProps
})