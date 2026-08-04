import { memo, splitProps } from '../helpers.mjs';
import { createRecipe, mergeRecipes } from './create-recipe.mjs';

const aeonButtonFn = /* @__PURE__ */ createRecipe('aeonButton', {
  "variant": "solid",
  "size": "sm"
}, [])

const aeonButtonVariantMap = {
  "variant": [
    "solid",
    "outline",
    "ghost"
  ],
  "size": [
    "xs",
    "sm",
    "md",
    "lg"
  ]
}

const aeonButtonVariantKeys = Object.keys(aeonButtonVariantMap)

export const aeonButton = /* @__PURE__ */ Object.assign(memo(aeonButtonFn.recipeFn), {
  __recipe__: true,
  __name__: 'aeonButton',
  __getCompoundVariantCss__: aeonButtonFn.__getCompoundVariantCss__,
  raw: (props) => props,
  variantKeys: aeonButtonVariantKeys,
  variantMap: aeonButtonVariantMap,
  merge(recipe) {
    return mergeRecipes(this, recipe)
  },
  splitVariantProps(props) {
    return splitProps(props, aeonButtonVariantKeys)
  },
  getVariantProps: aeonButtonFn.getVariantProps,
})