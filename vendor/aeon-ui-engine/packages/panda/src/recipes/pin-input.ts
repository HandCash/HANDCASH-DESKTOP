import { defineSlotRecipe } from '@pandacss/dev'

export const pinInputRecipe = defineSlotRecipe({
  className: 'aeonPinInput',
  slots: ['root', 'input'],
  base: {
    root: {
      display: 'inline-flex',
      gap: 'gapLg',
    },
    input: {
      width: '2.5rem',
      height: '2.75rem',
      textAlign: 'center',
      fontSize: 'lg',
      fontFamily: 'ui',
      fontWeight: 'semibold',
      borderRadius: 'md',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'border',
      bg: 'surface',
      color: 'fg',
      outline: 'none',
      boxSizing: 'border-box',
      _focusVisible: { borderColor: 'accent', boxShadow: 'none' },
      '&[data-aeon-state=filled]': { borderColor: 'accent' },
    },
  },
})
