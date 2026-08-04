import { defineRecipe } from '@pandacss/dev'

/** Layout wrapper for multiple buttons — wrap + gap so controls never overlap. */
export const buttonGroupRecipe = defineRecipe({
  className: 'aeonButtonGroup',
  description: 'Horizontal or vertical stack of buttons with consistent spacing',
  base: {
    display: 'inline-flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: '0.5rem',
    verticalAlign: 'middle',
    minW: 0,
    maxW: '100%',
    /* Children keep intrinsic width — wrap to next line instead of stacking. */
    '& > *': {
      flexShrink: 0,
      minW: 0,
    },
  },
  variants: {
    orientation: {
      horizontal: {},
      vertical: {
        flexDirection: 'column',
        alignItems: 'flex-start',
        flexWrap: 'nowrap',
      },
    },
    gap: {
      sm: { gap: '0.5rem' },
      md: { gap: '0.75rem' },
      lg: { gap: '1rem' },
    },
  },
  defaultVariants: {
    orientation: 'horizontal',
    gap: 'sm',
  },
})
