import { defineSlotRecipe } from '@pandacss/dev'

/**
 * Constrained text: truncate (ellipsis) or carousel (marquee) when overflowing.
 * Styles key off data-aeon-state: fits | truncate | carousel | paused.
 */
export const textOverflowRecipe = defineSlotRecipe({
  className: 'aeonTextOverflow',
  description: 'Text overflow: truncate or carousel inside a fixed slot',
  slots: ['root', 'viewport', 'track', 'item'],
  base: {
    root: {
      display: 'inline-flex',
      minW: '0',
      maxW: '100%',
      overflow: 'hidden',
      verticalAlign: 'bottom',
    },
    viewport: {
      display: 'block',
      minW: '0',
      maxW: '100%',
      overflow: 'hidden',
    },
    track: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '2rem',
      width: 'max-content',
      maxW: 'none',
      whiteSpace: 'nowrap',
    },
    item: {
      display: 'inline-block',
      flexShrink: 0,
      whiteSpace: 'nowrap',
    },
  },
})
