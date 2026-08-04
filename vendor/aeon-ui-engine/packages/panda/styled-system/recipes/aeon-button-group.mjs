import { memo, splitProps } from '../helpers.mjs';
import { createRecipe, mergeRecipes } from './create-recipe.mjs';

const aeonButtonGroupFn = /* @__PURE__ */ createRecipe('aeonButtonGroup', {
  "orientation": "horizontal",
  "gap": "sm"
}, [])

const aeonButtonGroupVariantMap = {
  "orientation": [
    "horizontal",
    "vertical"
  ],
  "gap": [
    "sm",
    "md",
    "lg"
  ]
}

const aeonButtonGroupVariantKeys = Object.keys(aeonButtonGroupVariantMap)

export const aeonButtonGroup = /* @__PURE__ */ Object.assign(memo(aeonButtonGroupFn.recipeFn), {
  __recipe__: true,
  __name__: 'aeonButtonGroup',
  __getCompoundVariantCss__: aeonButtonGroupFn.__getCompoundVariantCss__,
  raw: (props) => props,
  variantKeys: aeonButtonGroupVariantKeys,
  variantMap: aeonButtonGroupVariantMap,
  merge(recipe) {
    return mergeRecipes(this, recipe)
  },
  splitVariantProps(props) {
    return splitProps(props, aeonButtonGroupVariantKeys)
  },
  getVariantProps: aeonButtonGroupFn.getVariantProps,
})