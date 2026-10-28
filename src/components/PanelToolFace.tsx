import type { ButtonHTMLAttributes, ReactNode } from 'react'

type FaceProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Selected / pressed phase — clears to the gray track in the banner tools pill. */
  active?: boolean
}

/**
 * One icon face for page toolbars (Friends, Apps, Activity, …).
 *
 * Inline / compact: bordered 28px plate (`.panel-tool-face`).
 * Inside `.wallet-nav-section-banner-tools`: peer of nav tabs — 34px black
 * plate on the gray track, gap 0, end-cap radius (see page-banner-gray-pill).
 */
export function PanelToolFace({
  active,
  className,
  type = 'button',
  ...rest
}: FaceProps) {
  return (
    <button
      type={type}
      className={['panel-tool-face', className].filter(Boolean).join(' ')}
      data-active={active ? true : undefined}
      {...rest}
    />
  )
}

/** Groups faces (e.g. list/grid). Banner tools flatten this with `display: contents`. */
export function PanelToolGroup({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={['panel-tool-group', className].filter(Boolean).join(' ')}
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  )
}
