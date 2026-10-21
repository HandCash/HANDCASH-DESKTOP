import { defineSlotRecipe } from '@pandacss/dev'

const slots = ['root'] as const

const pad = 'var(--aeon-textarea-pad)'

export const textareaRecipe = defineSlotRecipe({
  className: 'aeonTextarea',
  description: 'Multi-line input that grows with content between min and max rows',
  slots,
  base: {
    root: {
      '--aeon-textarea-pad': 'token(spacing.insetYSm)',
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      /* Rows are set by the headless part; 1lh is one line at the current line height. */
      fieldSizing: 'content',
      minH: `calc(var(--aeon-textarea-min-rows, 2) * 1lh + 2 * ${pad} + 2px)`,
      maxH: `calc(var(--aeon-textarea-max-rows, 1e4) * 1lh + 2 * ${pad} + 2px)`,
      overflowY: 'auto',
      resize: 'none',
      m: '0',
      px: 'insetX',
      py: pad,
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'border',
      borderRadius: 'md',
      bg: 'surface',
      color: 'fg',
      fontFamily: 'ui',
      fontSize: 'sm',
      lineHeight: '1.5',
      outline: 'none',
      transitionProperty: 'border-color',
      transitionDuration: 'normal',
      _placeholder: { color: 'muted' },
      _focusVisible: { borderColor: 'accent' },
      '&[aria-invalid=true]': { borderColor: 'danger' },
      _disabled: { opacity: 0.6, cursor: 'not-allowed' },
    },
  },
  variants: {
    variant: {
      outline: {},
      /* Bare text inside a container that draws its own chrome (composers, inline editors). */
      ghost: {
        root: {
          '--aeon-textarea-pad': '0px',
          px: '0',
          borderColor: 'transparent',
          bg: 'transparent',
          _focusVisible: { borderColor: 'transparent' },
        },
      },
    },
  },
  defaultVariants: { variant: 'outline' },
})
