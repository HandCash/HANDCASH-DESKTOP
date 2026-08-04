import { defineSlotRecipe } from '@pandacss/dev'

export const fieldRecipe = defineSlotRecipe({
  className: 'aeonField',
  description: 'Form field with orthogonal interaction, validation, and submission states',
  slots: ['root', 'label', 'control', 'textarea', 'message', 'hint'],
  base: {
    root: {
      display: 'flex',
      flexDirection: 'column',
      gap: '2',
      alignItems: 'flex-start',
      width: '100%',
      maxW: '24rem',
    },
    label: {
      fontSize: 'sm',
      fontWeight: 'medium',
      color: 'fg',
    },
    control: {
      width: '100%',
      boxSizing: 'border-box',
      fontSize: 'sm',
      fontFamily: 'ui',
      lineHeight: '1.5',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'border',
      borderRadius: 'md',
      bg: 'surface',
      color: 'fg',
      px: 'insetX',
      py: 'insetYSm',
      outline: 'none',
      /* Border recolor only — no outer ring (outer rings inflate perceived size). */
      _focusVisible: {
        borderColor: 'accent',
        boxShadow: 'none',
      },
      '[data-aeon-state=invalid] > &, [data-aeon-validation=invalid] > &': {
        borderColor: 'danger',
      },
      '[data-aeon-state=pending] > &, [data-aeon-submission=pending] > &': {
        opacity: 0.7,
        pointerEvents: 'none',
      },
    },
    textarea: {
      width: '100%',
      boxSizing: 'border-box',
      minH: '6.5rem',
      resize: 'vertical',
      fontSize: 'sm',
      fontFamily: 'ui',
      lineHeight: '1.5',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'border',
      borderRadius: 'md',
      bg: 'surface',
      color: 'fg',
      px: 'insetX',
      py: 'insetYSm',
      outline: 'none',
      _focusVisible: {
        borderColor: 'accent',
        boxShadow: 'none',
      },
    },
    message: {
      fontSize: 'xs',
      m: '0',
      color: 'danger',
    },
    hint: {
      fontSize: 'xs',
      m: '0',
      color: 'muted',
    },
  },
})
