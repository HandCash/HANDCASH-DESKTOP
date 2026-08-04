import { defineSlotRecipe } from '@pandacss/dev'

const slots = ['root', 'image', 'fallback', 'badge'] as const

/** Circle clip — always round, regardless of consumer border-radius overrides. */
const circle = {
  borderRadius: '9999px',
} as const

export const avatarRecipe = defineSlotRecipe({
  className: 'aeonAvatar',
  description: 'Aeon avatar — always-round profile image with initials fallback + presence',
  slots,
  base: {
    root: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      verticalAlign: 'middle',
      position: 'relative',
      flexShrink: 0,
      aspectRatio: '1 / 1',
      ...circle,
      fontFamily: 'ui',
      /* Badge sits on the rim — keep root visible; clip faces on image/fallback. */
      overflow: 'visible',
      boxSizing: 'border-box',
    },
    image: {
      display: 'block',
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      ...circle,
      overflow: 'hidden',
    },
    fallback: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
      boxSizing: 'border-box',
      ...circle,
      overflow: 'hidden',
      fontWeight: 'semibold',
      letterSpacing: '-0.04em',
      lineHeight: '1',
      textTransform: 'uppercase',
      color: 'fg',
      bg: 'surfaceRaised',
      /* Fit 1–2 initials without clipping */
      px: '0.15rem',
      userSelect: 'none',
    },
    badge: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      ...circle,
      borderWidth: '2px',
      borderColor: 'bg',
      bg: 'muted',
      '&[data-aeon-state=active]': { bg: 'accent' },
      '&[data-aeon-state=away]': {
        bg: 'accentDim',
        outlineWidth: '1px',
        outlineStyle: 'solid',
        outlineColor: 'accent',
      },
      '&[data-aeon-state=busy]': { bg: 'danger' },
      '&[data-aeon-state=offline]': { bg: 'border' },
      '&[data-aeon-state=idle]': { bg: 'muted' },
    },
  },
  variants: {
    size: {
      /**
       * Size styles nest under root so Image/Fallback get the right type even when
       * styled slots are created without the size variant (ui Avatar pattern).
       */
      xs: {
        root: {
          width: '1.75rem',
          height: '1.75rem',
          '& [data-aeon-part=fallback]': { fontSize: '0.625rem' },
          '& [data-aeon-part=badge]': {
            width: '0.45rem',
            height: '0.45rem',
            borderWidth: '1px',
          },
        },
      },
      sm: {
        root: {
          width: '2.25rem',
          height: '2.25rem',
          '& [data-aeon-part=fallback]': { fontSize: '0.7rem' },
          '& [data-aeon-part=badge]': { width: '0.55rem', height: '0.55rem' },
        },
      },
      md: {
        root: {
          width: '2.75rem',
          height: '2.75rem',
          '& [data-aeon-part=fallback]': { fontSize: '0.8125rem' },
          '& [data-aeon-part=badge]': { width: '0.7rem', height: '0.7rem' },
        },
      },
      lg: {
        root: {
          width: '3.25rem',
          height: '3.25rem',
          '& [data-aeon-part=fallback]': { fontSize: '0.9375rem' },
          '& [data-aeon-part=badge]': { width: '0.8rem', height: '0.8rem' },
        },
      },
      xl: {
        root: {
          width: '4.25rem',
          height: '4.25rem',
          '& [data-aeon-part=fallback]': { fontSize: '1.125rem' },
          '& [data-aeon-part=badge]': { width: '0.95rem', height: '0.95rem' },
        },
      },
    },
  },
  defaultVariants: {
    size: 'md',
  },
})
