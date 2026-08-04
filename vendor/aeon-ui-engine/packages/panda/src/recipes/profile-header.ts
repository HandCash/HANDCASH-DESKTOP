import { defineSlotRecipe } from '@pandacss/dev'

const slots = ['root', 'media', 'identity', 'metrics', 'actions', 'body'] as const

export const profileHeaderRecipe = defineSlotRecipe({
  className: 'aeonProfileHeader',
  description: 'Dense profile / account header — maximize horizontal real estate',
  slots,
  base: {
    root: {
      display: 'flex',
      flexDir: 'column',
      gap: '0.65rem',
      width: '100%',
      minW: 0,
      p: '0.75rem 0.85rem',
      borderRadius: 'xl',
      borderWidth: '1px',
      borderColor: 'border',
      bg: 'surface',
    },
    media: {
      display: 'none',
      width: '100%',
      aspectRatio: '3 / 1',
      borderRadius: 'lg',
      overflow: 'hidden',
      bg: 'surfaceRaised',
      '&:not(:empty)': { display: 'grid', placeItems: 'center' },
    },
    identity: {
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      minW: 0,
      width: '100%',
    },
    metrics: {
      display: 'flex',
      alignItems: 'center',
      minW: 0,
      width: '100%',
      '&:empty': { display: 'none' },
    },
    actions: {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'stretch',
      justifyContent: 'flex-start',
      gap: '0.5rem',
      width: '100%',
      minW: 0,
      '&:empty': { display: 'none' },
      '& > *': { flexShrink: 1, minW: 0, maxW: '100%' },
      '& > [data-aeon-scope=button]': {
        flex: '1 1 5.5rem',
      },
      '& > [data-aeon-part=group]': {
        width: '100%',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem',
        minW: 0,
        '& > *': { flexShrink: 1, minW: 0 },
        '& > [data-aeon-scope=button]': {
          flex: '1 1 5.5rem',
          minW: 0,
          maxW: '100%',
        },
      },
    },
    body: {
      display: 'flex',
      flexDir: 'column',
      gap: '0.45rem',
      minW: 0,
      fontSize: 'sm',
      color: 'muted',
      lineHeight: '1.45',
      '&:empty': { display: 'none' },
      '& > p': {
        margin: 0,
        color: 'muted',
      },
    },
  },
  variants: {
    align: {
      start: {},
      center: {
        root: {
          alignItems: 'center',
          textAlign: 'center',
          '& [data-aeon-part=media]': {
            aspectRatio: '1',
            maxW: '7.5rem',
            borderRadius: 'full',
          },
          '& [data-aeon-part=identity]': {
            flexDirection: 'column',
            justifyContent: 'center',
          },
          '& [data-aeon-part=metrics]': {
            justifyContent: 'center',
          },
          '& [data-aeon-part=actions]': {
            justifyContent: 'center',
          },
          '& [data-aeon-part=body]': {
            alignItems: 'center',
            textAlign: 'center',
          },
        },
      },
    },
  },
  defaultVariants: {
    align: 'start',
  },
})
