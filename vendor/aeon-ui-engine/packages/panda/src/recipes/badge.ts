import { defineRecipe } from '@pandacss/dev'

export const badgeRecipe = defineRecipe({
  className: 'aeonBadge',
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    alignSelf: 'flex-start',
    fontSize: '0.6875rem',
    fontWeight: 'semibold',
    borderRadius: 'sm',
    borderWidth: '1px',
    borderStyle: 'solid',
    fontFamily: 'ui',
    lineHeight: '1.2',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    py: 'badgeY',
    px: 'badgeX',
    whiteSpace: 'nowrap',
  },
  variants: {
    variant: {
      default: {
        bg: 'surfaceRaised',
        color: 'muted',
        borderColor: 'border',
      },
      accent: {
        bg: 'accentDim',
        color: 'accent',
        borderColor: 'accent',
      },
      danger: {
        bg: 'dangerDim',
        color: 'danger',
        borderColor: 'danger',
      },
    },
  },
  defaultVariants: {
    variant: 'default',
  },
})
