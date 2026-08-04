/** Shared layout for label-wrapped controls (switch, checkbox, etc.). */
export const fieldRootBase = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'gapLg',
  cursor: 'pointer',
  fontFamily: 'ui',
  lineHeight: '1.5',
  verticalAlign: 'middle',
} as const

export const fieldLabelBase = {
  fontSize: 'sm',
  color: 'fg',
  userSelect: 'none',
  lineHeight: '1.5',
} as const

export const fieldControlReset = {
  margin: '0',
  padding: '0',
  lineHeight: '1',
  font: 'inherit',
  color: 'inherit',
  boxSizing: 'border-box',
  verticalAlign: 'middle',
  appearance: 'none',
  WebkitAppearance: 'none',
} as const
