import { defineSlotRecipe } from '@pandacss/dev'

const slots = ['root', 'track', 'range', 'label'] as const

export const progressRecipe = defineSlotRecipe({
  className: 'aeonProgress',
  slots,
  base: {
    root: {
      display: 'flex',
      flexDirection: 'column',
      gap: 'gapSm',
      fontFamily: 'ui',
      width: '100%',
      '&[data-aeon-state=loading] .aeonProgress__range': {
        width: '40%!',
        animation: 'aeonProgressIndeterminate 1.2s ease-in-out infinite',
      },
    },
    track: {
      position: 'relative',
      width: '100%',
      height: '0.5rem',
      borderRadius: 'full',
      bg: 'surface',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'border',
      overflow: 'hidden',
    },
    range: {
      height: '100%',
      borderRadius: 'full',
      bg: 'accent',
      transitionProperty: 'width',
      transitionDuration: 'normal',
    },
    label: {
      fontSize: 'sm',
      color: 'muted',
      lineHeight: 'snug',
    },
  },
})
