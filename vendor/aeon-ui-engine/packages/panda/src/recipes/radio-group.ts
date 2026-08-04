import { defineSlotRecipe } from '@pandacss/dev'
import { fieldLabelBase, fieldRootBase } from './field-shared.js'

const slots = ['root', 'item', 'itemControl', 'itemIndicator', 'itemLabel'] as const

export const radioGroupRecipe = defineSlotRecipe({
  className: 'aeonRadioGroup',
  slots,
  base: {
    root: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'gapSm',
      fontFamily: 'ui',
    },
    item: {
      ...fieldRootBase,
    },
    itemControl: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '1.5rem',
      height: '1.5rem',
      flexShrink: 0,
      borderRadius: 'full',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'border',
      bg: 'surface',
      cursor: 'pointer',
      transitionProperty: 'background-color, border-color',
      transitionDuration: 'normal',
      outline: 'none',
      _focusVisible: { boxShadow: 'focusRing' },
      _aeonSelected: {
        borderColor: 'accent',
      },
    },
    itemIndicator: {
      width: '0.625rem',
      height: '0.625rem',
      borderRadius: 'full',
      bg: 'accent',
    },
    itemLabel: {
      ...fieldLabelBase,
      cursor: 'pointer',
    },
  },
})
