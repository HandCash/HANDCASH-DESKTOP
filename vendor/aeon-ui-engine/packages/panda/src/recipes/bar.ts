import { defineSlotRecipe } from '@pandacss/dev'

/**
 * Bar — horizontal layout primitive for toolbars, headers, footers.
 *
 * Three-zone flex contract that makes overlap structurally impossible:
 * - root:   flex row, nowrap, overflow hidden — children cannot escape.
 * - leading:   flex 0 1 auto — shrinks before overflowing.
 * - center:    flex 1 1 0% — absorbs space, truncates content.
 * - trailing:  flex 0 1 auto — shrinks before overflowing.
 *
 * Responsive behavior is baked into the recipe via breakpoints,
 * so consumers never need ad-hoc media queries for bar layout.
 */
const slots = ['root', 'leading', 'center', 'trailing', 'seam'] as const

export const barRecipe = defineSlotRecipe({
  className: 'aeonBar',
  slots,
  base: {
    root: {
      /* 1fr | auto | 1fr — title stays optically centered even when sides are asymmetric. */
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
      alignItems: 'center',
      columnGap: '0.5rem',
      overflow: 'hidden',
      width: '100%',
      minWidth: 0,
      minH: '2.75rem',
      position: 'relative',
      bg: 'surface',
      color: 'fg',
    },
    leading: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-start',
      gap: '0.5rem',
      minWidth: 0,
      overflow: 'hidden',
      justifySelf: 'start',
    },
    center: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.5rem',
      minWidth: 0,
      maxWidth: '100%',
      overflow: 'hidden',
      justifySelf: 'center',
      textAlign: 'center',
      fontWeight: 'semibold',
      fontSize: '0.95rem',
      letterSpacing: '-0.02em',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
    },
    trailing: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: '0.5rem',
      minWidth: 0,
      overflow: 'hidden',
      justifySelf: 'end',
    },
    seam: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: '1px',
      bg: 'border',
      pointerEvents: 'none',
      '&[data-aeon-state=docked]': { opacity: 1 },
      '&[data-aeon-state=floating]': { opacity: 0.4 },
    },
  },
  variants: {
    /**
     * Size preset — controls padding and gap.
     * - xs: compact toolbars, status bars
     * - sm: standard app bars (default)
     * - md: page headers with more breathing room
     * - lg: marketing / hero bars
     */
    size: {
      xs: {
        root: { px: '0.5rem', py: '0.25rem', gap: '0.25rem' },
        leading: { gap: '0.25rem' },
        center: { gap: '0.25rem' },
        trailing: { gap: '0.25rem' },
      },
      sm: {
        root: { px: '0.75rem', py: '0.375rem', gap: '0.5rem' },
        leading: { gap: '0.375rem' },
        center: { gap: '0.375rem' },
        trailing: { gap: '0.375rem' },
      },
      md: {
        root: { px: '1rem', py: '0.5rem', gap: '0.75rem' },
        leading: { gap: '0.5rem' },
        center: { gap: '0.5rem' },
        trailing: { gap: '0.5rem' },
      },
      lg: {
        root: { px: '1.5rem', py: '0.75rem', gap: '1rem' },
        leading: { gap: '0.75rem' },
        center: { gap: '0.75rem' },
        trailing: { gap: '0.75rem' },
      },
    },
    /**
     * Sticky behavior — makes the bar stick to viewport edge.
     */
    sticky: {
      true: {
        root: {
          position: 'sticky',
          top: 'var(--aeon-bar-offset, 0px)',
          zIndex: 40,
        },
      },
    },
    /**
     * Machine-driven placement for StickyBar (top | bottom | inline).
     * Top stays relative/in-flow by default so AppShell.Header keeps height.
     * Opt into page stickiness with the `sticky` variant — never fixed on top
     * (fixed collapses parent chrome and covers content).
     */
    placement: {
      top: {
        root: {
          position: 'relative',
          zIndex: 50,
          width: '100%',
          '&[data-aeon-state=collapsed]': { py: '0.25rem', minH: '2.5rem' },
        },
      },
      bottom: {
        root: {
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 55,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        },
      },
      inline: {
        root: {
          position: 'relative',
          zIndex: 1,
        },
      },
    },
    /**
     * Responsive collapse mode — what happens when space runs out.
     * - shrink: zones shrink proportionally (default)
     * - wrap: root wraps at sm breakpoint, zones stack
     * - collapse-center: center zone hides on mobile, leading/trailing remain
     */
    collapse: {
      shrink: {},
      wrap: {
        root: {
          '@media (max-width: 640px)': {
            flexWrap: 'wrap',
          },
        },
        leading: {
          '@media (max-width: 640px)': {
            flex: '1 1 100%',
            order: 1,
          },
        },
        center: {
          '@media (max-width: 640px)': {
            flex: '1 1 100%',
            order: 2,
          },
        },
        trailing: {
          '@media (max-width: 640px)': {
            flex: '1 1 100%',
            order: 3,
            justifyContent: 'flex-end',
          },
        },
      },
      'collapse-center': {
        center: {
          '@media (max-width: 640px)': {
            display: 'none',
          },
        },
      },
    },
  },
  defaultVariants: {
    size: 'sm',
    collapse: 'shrink',
  },
})
