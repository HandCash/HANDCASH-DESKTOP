import { defineSlotRecipe } from '@pandacss/dev'

export const scrollRegionRecipe = defineSlotRecipe({
  className: 'aeonScroll',
  description: 'Scroll viewport with axis + edge states on data-aeon-state',
  slots: ['root', 'viewport', 'content'],
  base: {
    root: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'gapSm',
      minW: '0',
    },
    viewport: {
      position: 'relative',
      minW: '0',
      overflow: 'auto',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'border',
      borderRadius: 'md',
      bg: 'bg',
    },
    content: {
      minW: 'min-content',
    },
  },
  variants: {
    axis: {
      y: {
        viewport: { overflowX: 'hidden', overflowY: 'auto' },
      },
      x: {
        viewport: { overflowX: 'auto', overflowY: 'hidden' },
      },
      both: {
        viewport: { overflow: 'auto' },
      },
    },
    maxH: {
      sm: { viewport: { maxH: '8rem' } },
      md: { viewport: { maxH: '12rem' } },
      lg: { viewport: { maxH: '18rem' } },
    },
    maxW: {
      full: { viewport: { maxW: '100%' } },
      md: { viewport: { maxW: '20rem' } },
    },
  },
  defaultVariants: {
    axis: 'both',
    maxH: 'md',
    maxW: 'full',
  },
})
