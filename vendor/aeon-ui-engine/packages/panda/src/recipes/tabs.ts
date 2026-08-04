import { defineSlotRecipe } from '@pandacss/dev'

const slots = ['root', 'list', 'trigger', 'content', 'indicator'] as const

export const tabsRecipe = defineSlotRecipe({
  className: 'aeonTabs',
  slots,
  base: {
    root: {
      display: 'flex',
      flexDirection: 'column',
      gap: '4',
      fontFamily: 'ui',
    },
    list: {
      display: 'inline-flex',
      borderRadius: 'md',
      bg: 'surface',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'border',
      p: 'insetYSm',
      gap: 'insetYSm',
    },
    trigger: {
      fontSize: 'sm',
      borderRadius: '0.375rem',
      color: 'muted',
      py: 'insetY',
      px: 'insetXSm',
      minH: '2.5rem',
      cursor: 'pointer',
      transitionProperty: 'color, background-color',
      transitionDuration: 'normal',
      outline: 'none',
      _focusVisible: { boxShadow: 'focusRing' },
      _aeonSelected: {
        bg: 'surfaceRaised',
        color: 'accent',
      },
    },
    content: {
      fontSize: 'sm',
      color: 'fg',
      lineHeight: '1.65',
      pt: 'padMd',
      px: 'insetXSm',
    },
  },
})
