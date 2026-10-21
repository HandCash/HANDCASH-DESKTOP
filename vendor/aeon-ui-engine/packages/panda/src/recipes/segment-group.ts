import { defineSlotRecipe } from '@pandacss/dev'

const slots = ['root', 'item'] as const

export const segmentGroupRecipe = defineSlotRecipe({
  className: 'aeonSegmentGroup',
  description: 'Compact single choice: adjacent buttons on a shared track',
  slots,
  base: {
    root: {
      display: 'inline-flex',
      flexShrink: 0,
      alignItems: 'stretch',
      gap: '2px',
      p: '2px',
      borderRadius: 'md',
      bg: 'surfaceRaised',
      fontFamily: 'ui',
      '&[data-orientation=vertical]': { flexDirection: 'column' },
      _disabled: { opacity: 0.6 },
    },
    item: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.35em',
      border: '0',
      borderRadius: 'calc(token(radii.md) - 2px)',
      bg: 'transparent',
      color: 'muted',
      fontWeight: 'semibold',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      outline: 'none',
      transitionProperty: 'color, background-color',
      transitionDuration: 'normal',
      _hover: { color: 'fg' },
      _focusVisible: { boxShadow: 'focusRing' },
      _aeonSelected: { bg: 'bg', color: 'fg' },
      _disabled: { cursor: 'not-allowed', _hover: { color: 'muted' } },
    },
  },
  variants: {
    size: {
      sm: { item: { fontSize: 'xs', px: '0.6rem', py: '0.2rem' } },
      md: { item: { fontSize: 'sm', px: 'insetXSm', py: 'insetYSm' } },
    },
  },
  defaultVariants: { size: 'md' },
})
