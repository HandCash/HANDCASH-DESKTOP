import { defineSemanticTokens } from '@pandacss/dev'

/** Color semantics only — font/radius/shadow tokens use direct keys to avoid circular refs. */
export const semanticTokens = defineSemanticTokens({
  colors: {
    bg: { value: 'var(--colors-aeon-bg)' },
    surface: { value: 'var(--colors-aeon-surface)' },
    surfaceRaised: { value: 'var(--colors-aeon-surface-raised)' },
    border: { value: 'var(--colors-aeon-border)' },
    fg: { value: 'var(--colors-aeon-text)' },
    muted: { value: 'var(--colors-aeon-muted)' },
    accent: { value: 'var(--colors-aeon-accent)' },
    accentDim: { value: 'var(--colors-aeon-accent-dim)' },
    danger: { value: 'var(--colors-aeon-danger)' },
    dangerDim: { value: 'var(--colors-aeon-danger-dim)' },
  },
})
