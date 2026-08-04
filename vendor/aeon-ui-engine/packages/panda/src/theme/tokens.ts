import { defineTokens } from '@pandacss/dev'

export const tokens = defineTokens({
  fonts: {
    ui: { value: "'IBM Plex Sans', system-ui, sans-serif" },
    mono: { value: "'IBM Plex Mono', ui-monospace, monospace" },
    display: { value: "'Syne', system-ui, sans-serif" },
    body: { value: "'Instrument Sans', system-ui, sans-serif" },
  },
  /* Aeon palette is set only via theme-runtime.css (html[data-aeon-theme][data-aeon-mode]). */
  colors: {},
  radii: {
    sm: { value: '0.375rem' },
    md: { value: '0.5rem' },
    lg: { value: '0.625rem' },
    siteLg: { value: '10px' },
  },
  shadows: {
    panel: { value: '0 8px 32px #00000066' },
    focusRing: { value: '0 0 0 2px #0c0e12, 0 0 0 4px #5eead4' },
  },
  spacing: {
    /** Compact chrome — buttons, badges, selects (not panel insets). */
    controlX: { value: '0.75rem' },
    controlY: { value: '0.375rem' },
    controlXSm: { value: '0.625rem' },
    controlYSm: { value: '0.3125rem' },
    /** Shared min-heights — button sizes and matching inputs align to these tiers. */
    controlMinHXs: { value: '1.75rem' },
    controlMinHSm: { value: '2rem' },
    controlMinHMd: { value: '2.25rem' },
    controlMinHLg: { value: '2.5rem' },
    badgeX: { value: '0.5rem' },
    badgeY: { value: '0.125rem' },
    insetXSm: { value: '1.125rem' },
    insetYSm: { value: '0.75rem' },
    insetX: { value: '1.5rem' },
    insetY: { value: '0.875rem' },
    insetXLg: { value: '1.75rem' },
    insetYLg: { value: '1.125rem' },
    padSm: { value: '1.25rem' },
    padMd: { value: '1.625rem' },
    padLg: { value: '2rem' },
    padXl: { value: '2.5rem' },
    gapSm: { value: '0.75rem' },
    gap: { value: '1rem' },
    gapLg: { value: '1.25rem' },
    accordionGap: { value: '0.75rem' },
    accordionInsetX: { value: '1.75rem' },
    accordionTriggerY: { value: '1.375rem' },
    accordionTriggerMinH: { value: '3.5rem' },
    /** @deprecated Prefer padMd on itemContent — kept for legacy --aeon-* aliases */
    accordionContentY: { value: '1rem' },
    accordionContentB: { value: '1rem' },
  },
})
