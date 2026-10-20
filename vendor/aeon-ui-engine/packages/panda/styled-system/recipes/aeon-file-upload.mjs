import { compact, getSlotCompoundVariant, memo, splitProps } from '../helpers.mjs';
import { createRecipe } from './create-recipe.mjs';

const aeonFileUploadDefaultVariants = {}
const aeonFileUploadCompoundVariants = []

const aeonFileUploadSlotNames = [
  [
    "root",
    "aeonFileUpload__root"
  ],
  [
    "dropzone",
    "aeonFileUpload__dropzone"
  ],
  [
    "input",
    "aeonFileUpload__input"
  ],
  [
    "label",
    "aeonFileUpload__label"
  ],
  [
    "hint",
    "aeonFileUpload__hint"
  ],
  [
    "preview",
    "aeonFileUpload__preview"
  ],
  [
    "clearTrigger",
    "aeonFileUpload__clearTrigger"
  ],
  [
    "rejectionMessage",
    "aeonFileUpload__rejectionMessage"
  ]
]
const aeonFileUploadSlotFns = /* @__PURE__ */ aeonFileUploadSlotNames.map(([slotName, slotKey]) => [slotName, createRecipe(slotKey, aeonFileUploadDefaultVariants, getSlotCompoundVariant(aeonFileUploadCompoundVariants, slotName))])

const aeonFileUploadFn = memo((props = {}) => {
  return Object.fromEntries(aeonFileUploadSlotFns.map(([slotName, slotFn]) => [slotName, slotFn.recipeFn(props)]))
})

const aeonFileUploadVariantKeys = []
const getVariantProps = (variants) => ({ ...aeonFileUploadDefaultVariants, ...compact(variants) })

export const aeonFileUpload = /* @__PURE__ */ Object.assign(aeonFileUploadFn, {
  __recipe__: false,
  __name__: 'aeonFileUpload',
  raw: (props) => props,
  classNameMap: {},
  variantKeys: aeonFileUploadVariantKeys,
  variantMap: {},
  splitVariantProps(props) {
    return splitProps(props, aeonFileUploadVariantKeys)
  },
  getVariantProps
})