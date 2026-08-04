import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonThemeSwitcherDefaultVariants = {
  "size": "sm"
}
const aeonThemeSwitcherCompoundVariants = []

const aeonThemeSwitcherSlotNames = [
  [
    "root",
    "aeonThemeSwitcher__root"
  ],
  [
    "modes",
    "aeonThemeSwitcher__modes"
  ],
  [
    "modeBtn",
    "aeonThemeSwitcher__modeBtn"
  ],
  [
    "themeSelect",
    "aeonThemeSwitcher__themeSelect"
  ],
  [
    "themeTrigger",
    "aeonThemeSwitcher__themeTrigger"
  ]
]
const aeonThemeSwitcherSlotFns = /* @__PURE__ */ aeonThemeSwitcherSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonThemeSwitcherDefaultVariants, getSlotCompoundVariant(aeonThemeSwitcherCompoundVariants, slotName))])

const aeonThemeSwitcherFn = memo((props = {}) => {
  return Object.fromEntries(aeonThemeSwitcherSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonThemeSwitcherVariantKeys = [
  "size"
]
const getVariantProps = (variants) => ({ ...aeonThemeSwitcherDefaultVariants, ...compact(variants) })

export const aeonThemeSwitcher = /* @__PURE__ */ Object.assign(aeonThemeSwitcherFn, {
  __recipe__: false,
  __name__: 'aeonThemeSwitcher',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonThemeSwitcherVariantKeys,
  variantMap: {
  "size": [
    "xs",
    "sm",
    "md"
  ]
},
  splitVariantProps(props) {
    return splitProps(props, aeonThemeSwitcherVariantKeys)
  },
  getVariantProps
})