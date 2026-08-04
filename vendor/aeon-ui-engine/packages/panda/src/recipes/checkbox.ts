import { defineSlotRecipe } from '@pandacss/dev'
import { fieldControlReset, fieldLabelBase, fieldRootBase } from './field-shared.js'

const slots = ['root', 'control', 'indicator', 'label', 'hiddenInput'] as const

export const checkboxRecipe = defineSlotRecipe({
  className: 'aeonCheckbox',
  slots,
  base: {
    root: fieldRootBase,
    control: {
      ...fieldControlReset,
      width: '1.5rem',
      height: '1.5rem',
      flexShrink: 0,
      borderRadius: 'md',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'border',
      bg: 'surface',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      transitionProperty: 'background-color, border-color',
      transitionDuration: 'normal',
      outline: 'none',
      _focusVisible: { boxShadow: 'focusRing' },
      _aeonChecked: {
        bg: 'accent',
        borderColor: 'accent',
      },
    },
    indicator: {
      color: 'bg',
      fontSize: 'xs',
      fontWeight: 'bold',
    },
    label: fieldLabelBase,
  },
})
