import { defineSlotRecipe } from '@pandacss/dev'

const slots = [
  'list',
  'root',
  'header',
  'leading',
  'heading',
  'title',
  'subtitle',
  'meta',
  'media',
  'body',
  'values',
  'value',
  'actions',
  'footer',
] as const

/**
 * Entry — compact multi-value card for feeds, listings, activity.
 * Density + layout variants keep social posts and catalog rows on one primitive.
 */
export const entryRecipe = defineSlotRecipe({
  className: 'aeonEntry',
  slots,
  base: {
    list: {
      display: 'flex',
      flexDir: 'column',
      gap: '0.55rem',
      width: '100%',
      minW: 0,
    },
    root: {
      display: 'flex',
      flexDir: 'column',
      gap: '0.45rem',
      width: '100%',
      minW: 0,
      p: '0.65rem 0.7rem',
      borderRadius: 'xl',
      borderWidth: '1px',
      borderColor: 'border',
      bg: 'surface',
      color: 'fg',
      transitionProperty: 'background, border-color, opacity',
      transitionDuration: '0.15s',
      '&[data-aeon-state=selected]': {
        borderColor: 'accent',
        bg: 'accentDim',
      },
      '&[data-aeon-state=muted]': {
        opacity: 0.72,
      },
    },
    header: {
      display: 'grid',
      gridTemplateColumns: 'auto minmax(0, 1fr) auto',
      alignItems: 'center',
      columnGap: '0.55rem',
      width: '100%',
      minW: 0,
    },
    leading: {
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      '&:empty': { display: 'none' },
    },
    heading: {
      display: 'flex',
      flexDir: 'column',
      gap: '0.1rem',
      minW: 0,
    },
    title: {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: '0.8125rem',
      fontWeight: 'semibold',
      letterSpacing: '-0.01em',
      lineHeight: '1.25',
      color: 'fg',
    },
    subtitle: {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: '0.68rem',
      color: 'muted',
      lineHeight: '1.3',
      '&:empty': { display: 'none' },
    },
    meta: {
      flexShrink: 0,
      justifySelf: 'end',
      fontSize: '0.65rem',
      color: 'muted',
      whiteSpace: 'nowrap',
      '&:empty': { display: 'none' },
    },
    media: {
      display: 'none',
      width: '100%',
      aspectRatio: '16 / 10',
      borderRadius: 'lg',
      overflow: 'hidden',
      bg: 'surfaceRaised',
      '&:not(:empty)': { display: 'grid', placeItems: 'center' },
      '& img': {
        width: '100%',
        height: '100%',
        objectFit: 'cover',
      },
    },
    body: {
      display: 'flex',
      flexDir: 'column',
      gap: '0.25rem',
      minW: 0,
      fontSize: '0.8125rem',
      color: 'fg',
      lineHeight: '1.45',
      '&:empty': { display: 'none' },
      '& > p': { margin: 0 },
    },
    values: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '0.35rem 0.65rem',
      width: '100%',
      minW: 0,
      '&:empty': { display: 'none' },
    },
    value: {
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: '0.25rem',
      fontSize: '0.68rem',
      color: 'muted',
      lineHeight: '1.2',
      whiteSpace: 'nowrap',
      '& strong, & b, & [data-aeon-part=strong]': {
        fontWeight: 'semibold',
        color: 'fg',
        fontSize: '0.75rem',
      },
    },
    actions: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '0.35rem',
      width: '100%',
      minW: 0,
      '&:empty': { display: 'none' },
      '& > *': { flexShrink: 0 },
      '& > [data-aeon-scope=button]': {
        flex: '0 0 auto',
      },
    },
    footer: {
      display: 'flex',
      alignItems: 'center',
      gap: '0.35rem',
      width: '100%',
      fontSize: '0.65rem',
      color: 'muted',
      '&:empty': { display: 'none' },
    },
  },
  variants: {
    density: {
      compact: {},
      cozy: {
        root: { gap: '0.65rem', p: '0.85rem' },
        title: { fontSize: '0.875rem' },
        body: { fontSize: '0.875rem' },
      },
    },
    /**
     * stack — vertical feed card (default).
     * split — media rail + content (listings / product rows).
     */
    layout: {
      stack: {},
      split: {
        root: {
          display: 'grid',
          gridTemplateColumns: '5.75rem minmax(0, 1fr)',
          gridTemplateRows: 'auto',
          columnGap: '0.65rem',
          alignItems: 'start',
          '& > [data-aeon-part=media]': {
            gridColumn: '1',
            gridRow: '1 / span 6',
            aspectRatio: '1',
            alignSelf: 'stretch',
            minH: '5.75rem',
          },
          '& > [data-aeon-part=header], & > [data-aeon-part=body], & > [data-aeon-part=values], & > [data-aeon-part=actions], & > [data-aeon-part=footer]':
            {
              gridColumn: '2',
            },
        },
      },
    },
  },
  defaultVariants: {
    density: 'compact',
    layout: 'stack',
  },
})
