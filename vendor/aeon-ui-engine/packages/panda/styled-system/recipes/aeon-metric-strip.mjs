import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonMetricStripDefaultVariants = {
  "density": "cluster"
}
const aeonMetricStripCompoundVariants = []

const aeonMetricStripSlotNames = [
  [
    "root",
    "aeonMetricStrip__root"
  ],
  [
    "chip",
    "aeonMetricStrip__chip"
  ],
  [
    "value",
    "aeonMetricStrip__value"
  ],
  [
    "label",
    "aeonMetricStrip__label"
  ]
]
const aeonMetricStripSlotFns = /* @__PURE__ */ aeonMetricStripSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonMetricStripDefaultVariants, getSlotCompoundVariant(aeonMetricStripCompoundVariants, slotName))])

const aeonMetricStripFn = memo((props = {}) => {
  return Object.fromEntries(aeonMetricStripSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonMetricStripVariantKeys = [
  "density"
]
const getVariantProps = (variants) => ({ ...aeonMetricStripDefaultVariants, ...compact(variants) })

export const aeonMetricStrip = /* @__PURE__ */ Object.assign(aeonMetricStripFn, {
  __recipe__: false,
  __name__: 'aeonMetricStrip',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonMetricStripVariantKeys,
  variantMap: {
  "density": [
    "cluster",
    "loose"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonMetricStripVariantKeys)
  },
  getVariantProps
})