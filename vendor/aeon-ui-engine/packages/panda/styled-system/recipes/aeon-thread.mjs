import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonThreadDefaultVariants = {}
const aeonThreadCompoundVariants = []

const aeonThreadSlotNames = [
  [
    "root",
    "aeonThread__root"
  ],
  [
    "list",
    "aeonThread__list"
  ],
  [
    "item",
    "aeonThread__item"
  ],
  [
    "bubble",
    "aeonThread__bubble"
  ],
  [
    "meta",
    "aeonThread__meta"
  ],
  [
    "day",
    "aeonThread__day"
  ],
  [
    "bind",
    "aeonThread__bind"
  ],
  [
    "card",
    "aeonThread__card"
  ],
  [
    "cardTitle",
    "aeonThread__cardTitle"
  ],
  [
    "cardBody",
    "aeonThread__cardBody"
  ],
  [
    "cardActions",
    "aeonThread__cardActions"
  ]
]
const aeonThreadSlotFns = /* @__PURE__ */ aeonThreadSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonThreadDefaultVariants, getSlotCompoundVariant(aeonThreadCompoundVariants, slotName))])

const aeonThreadFn = memo((props = {}) => {
  return Object.fromEntries(aeonThreadSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonThreadVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonThreadDefaultVariants, ...compact(variants) })

export const aeonThread = /* @__PURE__ */ Object.assign(aeonThreadFn, {
  __recipe__: false,
  __name__: 'aeonThread',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonThreadVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonThreadVariantKeys)
  },
  getVariantProps
})