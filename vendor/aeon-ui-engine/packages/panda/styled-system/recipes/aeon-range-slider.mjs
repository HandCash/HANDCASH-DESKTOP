import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonRangeSliderDefaultVariants = {}
const aeonRangeSliderCompoundVariants = []

const aeonRangeSliderSlotNames = [
  [
    "root",
    "aeonRangeSlider__root"
  ],
  [
    "track",
    "aeonRangeSlider__track"
  ],
  [
    "range",
    "aeonRangeSlider__range"
  ],
  [
    "thumb",
    "aeonRangeSlider__thumb"
  ],
  [
    "valueText",
    "aeonRangeSlider__valueText"
  ]
]
const aeonRangeSliderSlotFns = /* @__PURE__ */ aeonRangeSliderSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonRangeSliderDefaultVariants, getSlotCompoundVariant(aeonRangeSliderCompoundVariants, slotName))])

const aeonRangeSliderFn = memo((props = {}) => {
  return Object.fromEntries(aeonRangeSliderSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonRangeSliderVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonRangeSliderDefaultVariants, ...compact(variants) })

export const aeonRangeSlider = /* @__PURE__ */ Object.assign(aeonRangeSliderFn, {
  __recipe__: false,
  __name__: 'aeonRangeSlider',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonRangeSliderVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonRangeSliderVariantKeys)
  },
  getVariantProps
})