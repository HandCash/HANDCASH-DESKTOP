import { defineSlotRecipe } from '@pandacss/dev'

/** Content region — every machine state has a visible slot. */
const slots = [
  'root',
  'toolbar',
  'body',
  'pending',
  'empty',
  'error',
  'success',
  'sentinel',
] as const

export const contentRecipe = defineSlotRecipe({
  className: 'aeonContent',
  slots,
  base: {
    root: {
      display: 'flex',
      flexDir: 'column',
      gap: '1rem',
      width: '100%',
      minW: 0,
      flex: '1 1 auto',
    },
    toolbar: {
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem',
      width: '100%',
    },
    body: {
      flex: '1 1 auto',
      minW: 0,
      display: 'flex',
      flexDir: 'column',
      gap: '0.85rem',
    },
    pending: {
      display: 'grid',
      placeItems: 'center',
      minH: '8rem',
      color: 'muted',
      textAlign: 'center',
    },
    empty: {
      display: 'grid',
      placeItems: 'center',
      gap: '0.75rem',
      minH: '8rem',
      textAlign: 'center',
      color: 'muted',
    },
    error: {
      display: 'grid',
      placeItems: 'center',
      gap: '0.75rem',
      minH: '8rem',
      textAlign: 'center',
      color: 'danger',
    },
    success: {
      display: 'grid',
      placeItems: 'center',
      gap: '0.75rem',
      minH: '4rem',
      textAlign: 'center',
    },
    sentinel: {
      height: '1px',
      width: '100%',
      '&[data-aeon-state=loadingMore]': {
        height: '3rem',
        display: 'grid',
        placeItems: 'center',
      },
    },
  },
  variants: {
    align: {
      start: {},
      center: {
        root: {
          alignItems: 'center',
          justifyContent: 'safe center',
          textAlign: 'center',
          minH: 0,
          '& [data-aeon-part=body]': {
            alignItems: 'center',
            width: '100%',
            maxW: '20rem',
          },
          '& [data-aeon-part=toolbar]': {
            justifyContent: 'center',
          },
        },
      },
    },
  },
  defaultVariants: {
    align: 'start',
  },
})
