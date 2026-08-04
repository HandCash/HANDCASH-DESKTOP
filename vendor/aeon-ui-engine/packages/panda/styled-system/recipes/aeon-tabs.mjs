import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonTabsDefaultVariants = {}
const aeonTabsCompoundVariants = []

const aeonTabsSlotNames = [
  [
    "root",
    "aeonTabs__root"
  ],
  [
    "list",
    "aeonTabs__list"
  ],
  [
    "trigger",
    "aeonTabs__trigger"
  ],
  [
    "content",
    "aeonTabs__content"
  ],
  [
    "indicator",
    "aeonTabs__indicator"
  ]
]
const aeonTabsSlotFns = /* @__PURE__ */ aeonTabsSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonTabsDefaultVariants, getSlotCompoundVariant(aeonTabsCompoundVariants, slotName))])

const aeonTabsFn = memo((props = {}) => {
  return Object.fromEntries(aeonTabsSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonTabsVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonTabsDefaultVariants, ...compact(variants) })

export const aeonTabs = /* @__PURE__ */ Object.assign(aeonTabsFn, {
  __recipe__: false,
  __name__: 'aeonTabs',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonTabsVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonTabsVariantKeys)
  },
  getVariantProps
})