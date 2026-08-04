import { defineSlotRecipe } from '@pandacss/dev'

const slots = ['root', 'leading', 'label', 'description', 'trailing'] as const

/**
 * ListRow — settings / people row.
 * When description has content, expands to a 2-line main column (likes / directory).
 * Leading accepts icons or avatars without clipping.
 */
export const listRowRecipe = defineSlotRecipe({
  className: 'aeonListRow',
  description: 'Settings / people list row — full-width hit target',
  slots,
  base: {
    root: {
      display: 'grid',
      gridTemplateColumns: 'auto minmax(0, 1fr) auto',
      gridTemplateRows: 'auto',
      alignItems: 'center',
      columnGap: '0.75rem',
      rowGap: '0.1rem',
      width: '100%',
      minH: '3rem',
      px: '0.65rem',
      py: '0.45rem',
      borderRadius: 'xl',
      border: 'none',
      bg: 'transparent',
      color: 'fg',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer',
      transitionProperty: 'background',
      transitionDuration: '0.15s',
      _hover: { bg: 'surface' },
      /* Description present → two-line main; leading/trailing span both rows. */
      '&:has([data-aeon-part=description]:not(:empty))': {
        gridTemplateRows: 'auto auto',
        minH: '3.35rem',
        py: '0.5rem',
        '& > [data-aeon-part=leading]': {
          gridRow: '1 / -1',
          alignSelf: 'center',
        },
        '& > [data-aeon-part=label]': {
          gridColumn: '2',
          gridRow: '1',
          alignSelf: 'end',
        },
        '& > [data-aeon-part=description]': {
          gridColumn: '2',
          gridRow: '2',
          alignSelf: 'start',
        },
        '& > [data-aeon-part=trailing]': {
          gridRow: '1 / -1',
          alignSelf: 'center',
        },
      },
    },
    leading: {
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minW: '1.25rem',
      minH: '1.25rem',
      color: 'muted',
      /* Avatars / larger glyphs size themselves; icon-only stays compact. */
      '& > [data-aeon-scope=avatar]': {
        /* Avatar sm = 2rem — optical match for people rows */
      },
    },
    label: {
      minW: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: 'sm',
      fontWeight: 'medium',
      color: 'fg',
      lineHeight: '1.25',
    },
    description: {
      display: 'none',
      minW: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: 'xs',
      color: 'muted',
      lineHeight: '1.3',
      '&:not(:empty)': {
        display: 'block',
      },
    },
    trailing: {
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: '0.35rem',
      color: 'muted',
      fontSize: 'xs',
      fontWeight: 'medium',
      whiteSpace: 'nowrap',
    },
  },
})
