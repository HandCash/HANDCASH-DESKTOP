import { defineSlotRecipe } from '@pandacss/dev'

/** Nav — top links, bottom tabs, side rail. */
const slots = ['root', 'item', 'indicator', 'label', 'icon', 'badge'] as const

export const navRecipe = defineSlotRecipe({
  className: 'aeonNav',
  slots,
  base: {
    root: {
      display: 'flex',
      alignItems: 'center',
      gap: '0.25rem',
      minW: 0,
      width: '100%',
      color: 'fg',
      '&[data-aeon-orientation=vertical]': {
        flexDir: 'column',
        alignItems: 'stretch',
      },
    },
    item: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.375rem',
      position: 'relative',
      px: '0.75rem',
      py: '0.5rem',
      borderRadius: 'xl',
      cursor: 'pointer',
      bg: 'transparent',
      color: 'muted',
      border: 'none',
      font: 'inherit',
      transitionProperty: 'color, background, opacity, transform',
      transitionDuration: '0.15s',
      _hover: {
        color: 'fg',
        bg: 'surfaceRaised',
      },
      '&[data-aeon-state=active]': {
        color: 'accent',
        bg: 'accentDim',
        fontWeight: 'medium',
      },
      '&[data-aeon-state=inactive]': {
        color: 'muted',
      },
      '&[data-aeon-state=disabled], &:disabled': {
        opacity: 0.45,
        cursor: 'not-allowed',
      },
    },
    indicator: {
      position: 'absolute',
      bottom: 0,
      left: '0.75rem',
      right: '0.75rem',
      height: '2px',
      borderRadius: 'full',
      bg: 'accent',
      opacity: 0,
      transitionProperty: 'opacity',
      transitionDuration: '0.15s',
      '[data-aeon-state=active] > &': { opacity: 1 },
    },
    label: {
      fontSize: 'xs',
      fontWeight: 'medium',
      letterSpacing: '-0.01em',
      lineHeight: '1',
      color: 'currentColor',
    },
    icon: {
      display: 'inline-flex',
      w: '1.35rem',
      h: '1.35rem',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      color: 'currentColor',
      '& svg': { width: '100%', height: '100%' },
    },
    badge: {
      fontSize: 'xs',
      px: '0.35rem',
      borderRadius: 'full',
      bg: 'accent',
      color: 'bg',
    },
  },
  variants: {
    size: {
      sm: {
        item: { px: '0.5rem', py: '0.375rem' },
        label: { fontSize: 'xs' },
        icon: { w: '1.2rem', h: '1.2rem' },
      },
      md: {},
      lg: {
        item: { px: '1rem', py: '0.625rem' },
        label: { fontSize: 'md' },
        icon: { w: '1.5rem', h: '1.5rem' },
      },
    },
    /**
     * layout — structural contract for how items fill space.
     * - inline: compact row (top links)
     * - dock: equal-width bottom tabs — icon above label (styles cascade from root)
     */
    layout: {
      inline: {},
      dock: {
        root: {
          display: 'flex',
          alignItems: 'stretch',
          justifyContent: 'space-between',
          gap: '0.1rem',
          width: '100%',
          minH: '2.75rem',
          '& [data-aeon-part=item]': {
            flex: '1 1 0%',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.12rem',
            minW: 0,
            px: '0.12rem',
            py: '0.22rem',
            borderRadius: 'md',
          },
          '& [data-aeon-part=indicator]': {
            display: 'none',
          },
          '& [data-aeon-part=label]': {
            fontSize: '0.62rem',
            maxW: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
          '& [data-aeon-part=icon]': {
            w: '1.25rem',
            h: '1.25rem',
          },
        },
      },
    },
  },
  defaultVariants: {
    size: 'md',
    layout: 'inline',
  },
})
