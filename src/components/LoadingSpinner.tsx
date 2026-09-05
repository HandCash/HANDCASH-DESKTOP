/**
 * One loading ring for Activity / Collectables / Tokens / side-column busy.
 * Size only — color always comes from `currentColor` / parent accent.
 */
export type LoadingSpinnerSize = 'sm' | 'md' | 'lg'

const SIZE_CLASS: Record<LoadingSpinnerSize, string> = {
  sm: 'loading-spinner--sm',
  md: 'loading-spinner--md',
  lg: 'loading-spinner--lg',
}

export function LoadingSpinner({
  size = 'sm',
  className,
}: {
  size?: LoadingSpinnerSize
  className?: string
}) {
  const classes = ['loading-spinner', SIZE_CLASS[size], className]
    .filter(Boolean)
    .join(' ')
  return <span className={classes} aria-hidden />
}
