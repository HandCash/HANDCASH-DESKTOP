import { defineSlotRecipe } from '@pandacss/dev'
import { fieldControlReset, fieldLabelBase, fieldRootBase } from './field-shared.js'

const slots = ['root', 'control', 'thumb', 'label', 'hiddenInput'] as const

export const switchRecipe = defineSlotRecipe({
  className: 'aeonSwitch',
  slots,
  base: {
    root: fieldRootBase,
    control: {
      ...fieldControlReset,
      display: 'inline-flex',
      alignItems: 'center',
      width: '3rem',
      height: '1.75rem',
      padding: '3px',
      flexShrink: 0,
      borderRadius: 'full',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'border',
      bg: 'surface',
      cursor: 'pointer',
      boxSizing: 'border-box',
      transitionProperty: 'background-color, border-color',
      transitionDuration: 'normal',
      outline: 'none',
      _focusVisible: { boxShadow: 'focusRing' },
      _aeonChecked: {
        bg: 'accentDim',
        borderColor: 'accent',
      },
    },
    thumb: {
      width: '1.125rem',
      height: '1.125rem',
      flexShrink: 0,
      borderRadius: 'full',
      bg: 'fg',
      pointerEvents: 'none',
      transitionProperty: 'margin, background-color',
      transitionDuration: 'normal',
      _aeonChecked: {
        marginLeft: 'auto',
        bg: 'accent',
      },
    },
    label: fieldLabelBase,
  },
})
