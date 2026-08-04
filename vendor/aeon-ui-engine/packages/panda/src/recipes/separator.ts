import { defineSlotRecipe } from '@pandacss/dev'

const slots = ['root'] as const

export const separatorRecipe = defineSlotRecipe({
  className: 'aeonSeparator',
  slots,
  base: {
    root: {
      flexShrink: 0,
      bg: 'border',
      border: 'none',
    },
  },
  variants: {
    orientation: {
      horizontal: {
        root: {
          width: '100%',
          height: '1px',
        },
      },
      vertical: {
        root: {
          width: '1px',
          height: '100%',
          alignSelf: 'stretch',
        },
      },
    },
  },
  defaultVariants: {
    orientation: 'horizontal',
  },
})
