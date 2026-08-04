import { memo, splitProps } from '../helpers.mjs';
import { createRecipe, mergeRecipes } from './create-recipe.mjs';

const aeonBadgeFn = /* @__PURE__ */ createRecipe('aeonBadge', {
  "variant": "default"
}, [])

const aeonBadgeVariantMap = {
  "variant": [
    "default",
    "accent",
    "danger"
  ]
}

const aeonBadgeVariantKeys = Object.keys(aeonBadgeVariantMap)

export const aeonBadge = /* @__PURE__ */ Object.assign(memo(aeonBadgeFn.recipeFn), {
  __recipe__: true,
  __name__: 'aeonBadge',
  __getCompoundVariantCss__: aeonBadgeFn.__getCompoundVariantCss__,
  raw: (props) => props,
  variantKeys: aeonBadgeVariantKeys,
  variantMap: aeonBadgeVariantMap,
  merge(recipe) {
    return mergeRecipes(this, recipe)
  },
  splitVariantProps(props) {
    return splitProps(props, aeonBadgeVariantKeys)
  },
  getVariantProps: aeonBadgeFn.getVariantProps,
})