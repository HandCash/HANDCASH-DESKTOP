import { defineSlotRecipe } from '@pandacss/dev'

const slots = ['root', 'avatar', 'title', 'subtitle', 'meta', 'trailing'] as const

export const identityRecipe = defineSlotRecipe({
  className: 'aeonIdentity',
  description: 'Identity strip — avatar + title + subtitle',
  slots,
  base: {
    root: {
      display: 'flex',
      alignItems: 'center',
      gap: '0.625rem',
      minW: 0,
      maxW: '100%',
      textAlign: 'left',
    },
    avatar: {
      flexShrink: 0,
      display: 'inline-flex',
    },
    title: {
      display: 'block',
      minW: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: 'sm',
      fontWeight: 'semibold',
      color: 'fg',
      lineHeight: 'tight',
    },
    subtitle: {
      display: 'block',
      minW: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: 'xs',
      color: 'muted',
      lineHeight: 'tight',
    },
    meta: {
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
    },
    trailing: {
      flexShrink: 0,
      marginLeft: 'auto',
      display: 'inline-flex',
      alignItems: 'center',
    },
  },
  variants: {
    size: {
      sm: {
        root: { gap: '0.5rem' },
        title: { fontSize: 'xs' },
        subtitle: { fontSize: '0.625rem' },
      },
      md: {},
      lg: {
        root: { gap: '0.75rem' },
        title: { fontSize: 'md' },
        subtitle: { fontSize: 'sm' },
      },
    },
  },
  defaultVariants: {
    size: 'md',
  },
})
