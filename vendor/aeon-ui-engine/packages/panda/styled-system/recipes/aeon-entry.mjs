import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonEntryDefaultVariants = {
  "density": "compact",
  "layout": "stack"
}
const aeonEntryCompoundVariants = []

const aeonEntrySlotNames = [
  [
    "list",
    "aeonEntry__list"
  ],
  [
    "root",
    "aeonEntry__root"
  ],
  [
    "header",
    "aeonEntry__header"
  ],
  [
    "leading",
    "aeonEntry__leading"
  ],
  [
    "heading",
    "aeonEntry__heading"
  ],
  [
    "title",
    "aeonEntry__title"
  ],
  [
    "subtitle",
    "aeonEntry__subtitle"
  ],
  [
    "meta",
    "aeonEntry__meta"
  ],
  [
    "media",
    "aeonEntry__media"
  ],
  [
    "body",
    "aeonEntry__body"
  ],
  [
    "values",
    "aeonEntry__values"
  ],
  [
    "value",
    "aeonEntry__value"
  ],
  [
    "actions",
    "aeonEntry__actions"
  ],
  [
    "footer",
    "aeonEntry__footer"
  ]
]
const aeonEntrySlotFns = /* @__PURE__ */ aeonEntrySlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonEntryDefaultVariants, getSlotCompoundVariant(aeonEntryCompoundVariants, slotName))])

const aeonEntryFn = memo((props = {}) => {
  return Object.fromEntries(aeonEntrySlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonEntryVariantKeys = [
  "density",
  "layout"
]
const getVariantProps = (variants) => ({ ...aeonEntryDefaultVariants, ...compact(variants) })

export const aeonEntry = /* @__PURE__ */ Object.assign(aeonEntryFn, {
  __recipe__: false,
  __name__: 'aeonEntry',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonEntryVariantKeys,
  variantMap: {
  "density": [
    "compact",
    "cozy"
  ],
  "layout": [
    "stack",
    "split"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonEntryVariantKeys)
  },
  getVariantProps
})