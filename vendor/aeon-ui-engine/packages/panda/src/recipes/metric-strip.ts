import { defineSlotRecipe } from '@pandacss/dev'

const slots = ['root', 'chip', 'value', 'label'] as const

export const metricStripRecipe = defineSlotRecipe({
  className: 'aeonMetricStrip',
  description: 'Dense metric chips — value + uppercase label',
  slots,
  base: {
    root: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'stretch',
      width: 'fit-content',
      maxW: '100%',
      gap: 0,
      borderWidth: '1px',
      borderColor: 'border',
      borderRadius: 'md',
      overflow: 'hidden',
      bg: 'surface',
      '&[data-aeon-density=loose]': {
        width: '100%',
        gap: '0.75rem',
        borderWidth: 0,
        bg: 'transparent',
        overflow: 'visible',
      },
    },
    chip: {
      display: 'flex',
      flexDir: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.05rem',
      px: '0.55rem',
      py: '0.3rem',
      minW: '2.75rem',
      borderRightWidth: '1px',
      borderRightColor: 'border',
      '&:last-child': { borderRightWidth: 0 },
      '[data-aeon-density=loose] &': {
        alignItems: 'flex-start',
        borderRightWidth: 0,
        minW: '4.5rem',
        px: 0,
        py: 0,
      },
    },
    value: {
      fontSize: '0.625rem',
      fontWeight: 'bold',
      fontVariantNumeric: 'tabular-nums',
      color: 'fg',
      lineHeight: '1',
      '[data-aeon-density=loose] &': { fontSize: 'md' },
    },
    label: {
      fontSize: '0.5rem',
      fontWeight: 'medium',
      textTransform: 'uppercase',
      letterSpacing: '0.1em',
      color: 'muted',
      lineHeight: '1',
      '[data-aeon-density=loose] &': {
        fontSize: '0.625rem',
        letterSpacing: '0.08em',
      },
    },
  },
  variants: {
    density: {
      cluster: {},
      loose: {},
    },
  },
  defaultVariants: {
    density: 'cluster',
  },
})
