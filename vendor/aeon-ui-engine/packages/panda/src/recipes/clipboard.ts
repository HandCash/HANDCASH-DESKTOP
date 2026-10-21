import { defineSlotRecipe } from '@pandacss/dev'

const slots = ['root', 'trigger', 'indicator', 'status'] as const

export const clipboardRecipe = defineSlotRecipe({
  className: 'aeonClipboard',
  description: 'Copy a value with one click; the trigger confirms copied or failed',
  slots,
  base: {
    root: {},
    trigger: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.35em',
      minW: '1.75rem',
      h: '1.75rem',
      px: '0.4rem',
      border: '0',
      borderRadius: 'md',
      bg: 'transparent',
      color: 'muted',
      fontFamily: 'ui',
      fontSize: 'xs',
      cursor: 'pointer',
      outline: 'none',
      transitionProperty: 'color, background-color',
      transitionDuration: 'normal',
      _hover: { bg: 'surfaceRaised', color: 'fg' },
      _focusVisible: { boxShadow: 'focusRing' },
      '&[data-aeon-state=copied]': { color: 'accent' },
      '&[data-aeon-state=failed]': { color: 'danger' },
    },
    indicator: {
      display: 'inline-flex',
      '& svg': { width: '0.875rem', height: '0.875rem' },
    },
    status: {},
  },
})
