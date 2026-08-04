import { defineSlotRecipe } from '@pandacss/dev'

/**
 * Panel — collapsible split-view region.
 * Expanded: content visible, label + trigger in a header row.
 * Collapsed: content hidden; label becomes a vertical upright rail (C\nO\nM…).
 */
const slots = ['group', 'root', 'trigger', 'label', 'content'] as const

export const panelRecipe = defineSlotRecipe({
  className: 'aeonPanel',
  slots,
  base: {
    group: {
      display: 'flex',
      alignItems: 'stretch',
      gap: '0.85rem',
      minWidth: 0,
      minHeight: 0,
      width: '100%',
      '&[data-aeon-orientation=horizontal]': {
        flexDirection: 'row',
      },
      '&[data-aeon-orientation=vertical]': {
        flexDirection: 'column',
      },
    },
    root: {
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) auto',
      gridTemplateRows: 'auto minmax(0, 1fr)',
      minWidth: 0,
      minHeight: 0,
      overflow: 'hidden',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'var(--border)',
      borderRadius: '8px',
      background: 'color-mix(in srgb, var(--aeon-bg) 60%, transparent)',
      transition: 'flex-basis 0.2s ease, width 0.2s ease, min-width 0.2s ease',
      '&[data-aeon-state=expanded]': {
        flex: '1 1 0%',
      },
      '&[data-aeon-state=collapsed]': {
        display: 'flex',
        flexDirection: 'column',
        flex: '0 0 2.75rem',
        width: '2.75rem',
        minWidth: '2.75rem',
        maxWidth: '2.75rem',
        alignItems: 'center',
        paddingBlock: '0.65rem',
        paddingInline: '0.2rem',
        cursor: 'pointer',
      },
    },
    trigger: {
      appearance: 'none',
      border: 'none',
      background: 'transparent',
      color: 'var(--text-muted)',
      fontSize: '0.7rem',
      fontWeight: '700',
      letterSpacing: '0.04em',
      cursor: 'pointer',
      padding: '0.85rem 0.65rem 0.35rem 0.25rem',
      borderRadius: '4px',
      alignSelf: 'start',
      lineHeight: 1,
      '&:hover': {
        color: 'var(--aeon-accent)',
      },
      '&:disabled': {
        opacity: 0.4,
        cursor: 'default',
      },
      '&[data-aeon-state=collapsed]': {
        display: 'none',
      },
    },
    label: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.05rem',
      fontSize: '0.65rem',
      fontWeight: '700',
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: 'var(--text-muted)',
      userSelect: 'none',
      minWidth: 0,
      '&[data-aeon-state=expanded]': {
        padding: '0.85rem 0.25rem 0.5rem 0.95rem',
        borderBottomWidth: '1px',
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--border)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      '&[data-aeon-state=collapsed]': {
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: '0.08rem',
        flex: '1 1 auto',
        height: '100%',
        writingMode: 'horizontal-tb',
        cursor: 'pointer',
        color: 'var(--aeon-accent)',
        padding: 0,
        borderBottom: 'none',
        '& [data-aeon-part=label-char]': {
          display: 'block',
          lineHeight: 1.15,
          fontSize: '0.72rem',
        },
        '& [data-aeon-part=label-gap]': {
          display: 'block',
          height: '0.55rem',
        },
      },
    },
    content: {
      gridColumn: '1 / -1',
      display: 'flex',
      flexDirection: 'column',
      flex: '1 1 auto',
      minHeight: 0,
      minWidth: 0,
      overflow: 'auto',
      padding: '0.75rem 0.95rem 1rem',
      '&[hidden]': {
        display: 'none',
      },
    },
  },
  variants: {
    size: {
      md: {},
      lg: {
        root: {
          '&[data-aeon-state=collapsed]': {
            flexBasis: '3rem',
            width: '3rem',
            minWidth: '3rem',
            maxWidth: '3rem',
          },
        },
      },
    },
  },
  defaultVariants: {
    size: 'md',
  },
})
