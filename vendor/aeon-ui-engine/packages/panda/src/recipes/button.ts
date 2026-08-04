import { defineRecipe } from '@pandacss/dev'

export const buttonRecipe = defineRecipe({
  className: 'aeonButton',
  description: 'Aeon button styles',
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    gap: '2',
    fontWeight: 'medium',
    fontFamily: 'ui',
    lineHeight: '1.25',
    transitionProperty: 'color, background-color, border-color, box-shadow, transform',
    transitionDuration: 'normal',
    cursor: 'pointer',
    outline: 'none',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    _focusVisible: {
      boxShadow: 'focusRing',
    },
    _disabled: {
      opacity: '0.4',
      pointerEvents: 'none',
    },
    _active: {
      transform: 'scale(0.98)',
    },
  },
  variants: {
    variant: {
      solid: {
        bg: 'accent',
        color: 'bg',
        _hover: { filter: 'brightness(1.1)' },
      },
      outline: {
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'border',
        bg: 'transparent',
        color: 'fg',
        _hover: { borderColor: 'accent' },
      },
      ghost: {
        bg: 'transparent',
        color: 'muted',
        _hover: {
          color: 'fg',
          bg: 'surfaceRaised',
        },
      },
    },
    size: {
      xs: {
        fontSize: '0.75rem',
        fontWeight: 'semibold',
        borderRadius: 'sm',
        py: 'controlYSm',
        px: 'controlXSm',
        minH: 'controlMinHXs',
      },
      sm: {
        fontSize: '0.8125rem',
        borderRadius: 'sm',
        py: 'controlY',
        px: 'controlX',
        minH: 'controlMinHSm',
      },
      md: {
        fontSize: '0.875rem',
        borderRadius: 'md',
        py: '0.4375rem',
        px: '0.875rem',
        minH: 'controlMinHMd',
      },
      lg: {
        fontSize: '0.9375rem',
        borderRadius: 'md',
        py: 'insetYSm',
        px: 'insetXSm',
        minH: 'controlMinHLg',
      },
    },
  },
  defaultVariants: {
    variant: 'solid',
    size: 'sm',
  },
})
