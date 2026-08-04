import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonSliderDefaultVariants = {}
const aeonSliderCompoundVariants = []

const aeonSliderSlotNames = [
  [
    "root",
    "aeonSlider__root"
  ],
  [
    "track",
    "aeonSlider__track"
  ],
  [
    "range",
    "aeonSlider__range"
  ],
  [
    "thumb",
    "aeonSlider__thumb"
  ],
  [
    "valueText",
    "aeonSlider__valueText"
  ]
]
const aeonSliderSlotFns = /* @__PURE__ */ aeonSliderSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonSliderDefaultVariants, getSlotCompoundVariant(aeonSliderCompoundVariants, slotName))])

const aeonSliderFn = memo((props = {}) => {
  return Object.fromEntries(aeonSliderSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonSliderVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonSliderDefaultVariants, ...compact(variants) })

export const aeonSlider = /* @__PURE__ */ Object.assign(aeonSliderFn, {
  __recipe__: false,
  __name__: 'aeonSlider',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonSliderVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonSliderVariantKeys)
  },
  getVariantProps
})