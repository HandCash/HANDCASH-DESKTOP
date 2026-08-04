import { defineSlotRecipe } from '@pandacss/dev'

/**
 * ThemeSwitcher — mode toggle + theme preset selector.
 *
 * Layout is a single-row flex container that never wraps or overflows.
 * The modes group and theme select sit side-by-side with consistent sizing.
 */
const slots = ['root', 'modes', 'modeBtn', 'themeSelect', 'themeTrigger'] as const

export const themeSwitcherRecipe = defineSlotRecipe({
  className: 'aeonThemeSwitcher',
  slots,
  base: {
    root: {
      display: 'flex',
      flexWrap: 'nowrap',
      alignItems: 'center',
      gap: '0.375rem',
      minWidth: 0,
      overflow: 'hidden',
    },
    modes: {
      display: 'inline-flex',
      alignItems: 'stretch',
      gap: '0.125rem',
      flexShrink: 0,
      padding: '2px',
      border: '1px solid {colors.border}',
      borderRadius: '{radii.md}',
      background: 'color-mix(in srgb, {colors.surface} 92%, {colors.bg})',
    },
    modeBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: '2.25rem',
      height: 'auto',
      paddingInline: '0.4rem',
      border: 'none',
      borderRadius: '{radii.sm}',
      background: 'transparent',
      cursor: 'pointer',
      fontFamily: '{fonts.ui}',
      fontSize: '{fontSizes.xs}',
      fontWeight: '{fontWeights.medium}',
      color: 'muted',
      transition: 'background 0.15s, color 0.15s, box-shadow 0.15s',
      _hover: {
        color: 'text',
        background: 'surfaceRaised',
      },
    },
    themeSelect: {
      flex: '0 1 auto',
      minWidth: 0,
      maxWidth: '6rem',
      overflow: 'hidden',
    },
    themeTrigger: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.25rem',
      width: '100%',
      maxWidth: '100%',
      minWidth: 0,
      paddingInline: '0.4rem 1.25rem',
      border: '1px solid {colors.border}',
      borderRadius: '{radii.md}',
      background: 'color-mix(in srgb, {colors.surface} 92%, {colors.bg})',
      cursor: 'pointer',
      fontFamily: '{fonts.ui}',
      fontSize: '{fontSizes.xs}',
      fontWeight: '{fontWeights.medium}',
      color: 'text',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      transition: 'background 0.15s',
      _hover: {
        background: 'surfaceRaised',
      },
    },
  },
  variants: {
    size: {
      xs: {
        root: { gap: '0.25rem' },
        modeBtn: { minWidth: '2rem', minH: '2rem', fontSize: '{fontSizes.xs}', paddingInline: '0.3rem' },
        themeTrigger: { fontSize: '{fontSizes.xs}', paddingInline: '0.3rem 1rem', minH: '2rem' },
        themeSelect: { maxWidth: '4.5rem' },
      },
      sm: {
        root: { gap: '0.375rem' },
        modeBtn: { minWidth: '2.25rem', fontSize: '{fontSizes.xs}', paddingInline: '0.4rem' },
        themeTrigger: { fontSize: '{fontSizes.xs}', paddingInline: '0.4rem 1.25rem' },
        themeSelect: { maxWidth: '6rem' },
      },
      md: {
        root: { gap: '0.5rem' },
        modeBtn: { minWidth: '2.75rem', fontSize: '{fontSizes.sm}', paddingInline: '0.5rem' },
        themeTrigger: { fontSize: '{fontSizes.sm}', paddingInline: '0.5rem 1.5rem' },
        themeSelect: { maxWidth: '7.5rem' },
      },
    },
  },
  defaultVariants: {
    size: 'sm',
  },
})
