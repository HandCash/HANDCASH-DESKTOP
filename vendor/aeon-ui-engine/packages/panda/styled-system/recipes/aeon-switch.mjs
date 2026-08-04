import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonSwitchDefaultVariants = {}
const aeonSwitchCompoundVariants = []

const aeonSwitchSlotNames = [
  [
    "root",
    "aeonSwitch__root"
  ],
  [
    "control",
    "aeonSwitch__control"
  ],
  [
    "thumb",
    "aeonSwitch__thumb"
  ],
  [
    "label",
    "aeonSwitch__label"
  ],
  [
    "hiddenInput",
    "aeonSwitch__hiddenInput"
  ]
]
const aeonSwitchSlotFns = /* @__PURE__ */ aeonSwitchSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonSwitchDefaultVariants, getSlotCompoundVariant(aeonSwitchCompoundVariants, slotName))])

const aeonSwitchFn = memo((props = {}) => {
  return Object.fromEntries(aeonSwitchSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonSwitchVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonSwitchDefaultVariants, ...compact(variants) })

export const aeonSwitch = /* @__PURE__ */ Object.assign(aeonSwitchFn, {
  __recipe__: false,
  __name__: 'aeonSwitch',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonSwitchVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonSwitchVariantKeys)
  },
  getVariantProps
})