import { defineSlotRecipe } from '@pandacss/dev'

/**
 * App shell — layered chrome (header / content / dock / scrim).
 * Z-index ladder mirrors items-market: content < sticky < header < dock < overlay.
 */
const slots = [
  'root',
  'header',
  'subheader',
  'content',
  'aside',
  'footer',
  'dock',
  'scrim',
] as const

export const appShellRecipe = defineSlotRecipe({
  className: 'aeonAppShell',
  slots,
  base: {
    root: {
      display: 'flex',
      flexDir: 'column',
      minH: '100dvh',
      width: '100%',
      position: 'relative',
      bg: 'bg',
      color: 'fg',
      '&[data-aeon-state=overlayOpen] [data-aeon-part=content]': {
        pointerEvents: 'none',
        filter: 'blur(2px)',
        opacity: 0.92,
      },
    },
    header: {
      /* In-flow chrome band — flex-shrink 0 so shell content never slides underneath. */
      position: 'relative',
      flexShrink: 0,
      zIndex: 50,
      width: '100%',
      bg: 'surface',
      color: 'fg',
      /* Seam on Bar/StickyBar owns the edge when nested — avoid double rule.
         StickyBar reuses bar anatomy (data-aeon-scope=bar), not a stickyBar scope. */
      borderBottomWidth: '1px',
      borderBottomColor: 'border',
      '&:has([data-aeon-scope=bar] [data-aeon-part=seam])': {
        borderBottomWidth: 0,
      },
      /* Nested top bar stays in flow; transparent so header surface is the only fill. */
      '& [data-aeon-scope=bar]': {
        position: 'relative',
        top: 'auto',
        left: 'auto',
        right: 'auto',
        bg: 'transparent',
      },
    },
    subheader: {
      position: 'sticky',
      top: 'var(--aeon-bar-offset, 4rem)',
      zIndex: 36,
      width: '100%',
    },
    content: {
      flex: '1 1 auto',
      minW: 0,
      minH: 0,
      display: 'flex',
      flexDir: 'column',
      px: '0.85rem',
      py: '0.85rem',
      transitionProperty: 'filter, opacity',
      transitionDuration: '0.2s',
    },
    aside: {
      position: 'sticky',
      top: 'var(--aeon-bar-offset, 4rem)',
      zIndex: 34,
      alignSelf: 'start',
      maxH: 'calc(100dvh - var(--aeon-bar-offset, 4rem))',
      overflow: 'auto',
    },
    footer: {
      width: '100%',
    },
    dock: {
      position: 'fixed',
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 55,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      px: '0.55rem',
      pt: '0.4rem',
      paddingBottom: 'calc(0.4rem + env(safe-area-inset-bottom, 0px))',
      bg: 'surface',
      color: 'fg',
      borderTopWidth: '1px',
      borderTopColor: 'border',
      /* Nested nav fills the dock track */
      '& > [data-aeon-scope=nav], & > [data-aeon-part=root]': {
        width: '100%',
        maxW: '22rem',
      },
    },
    scrim: {
      position: 'fixed',
      inset: 0,
      zIndex: 45,
      bg: 'black/40',
      backdropFilter: 'blur(2px)',
    },
  },
  variants: {
    /** Content column alignment — projects from screen intent (form vs feed). */
    contentAlign: {
      start: {
        content: { alignItems: 'stretch' },
      },
      center: {
        content: {
          alignItems: 'center',
          /* safe center — tall content stays scrollable from the top, never under the header */
          justifyContent: 'safe center',
          textAlign: 'center',
        },
      },
    },
  },
  defaultVariants: {
    contentAlign: 'start',
  },
})
