import type { ElementType, ReactNode } from 'react'
import { copyText } from '../wallet/clipboard'

type Props = {
  children: ReactNode
  /** Full text to copy — defaults to string children. */
  text?: string
  className?: string
  role?: 'alert' | 'status' | 'button'
  /** Use `span` inside StatusBanner.Body (already a paragraph). */
  as?: ElementType
}

/**
 * Error / status copy that pastes on click — long toolbox messages are useless
 * when truncated in a banner; one tap puts the full string on the clipboard.
 */
export function CopyableError({
  children,
  text,
  className = 'error',
  role = 'alert',
  as: Tag = 'p',
}: Props) {
  const copyPayload =
    text ??
    (typeof children === 'string' || typeof children === 'number'
      ? String(children)
      : '')
  const canCopy = Boolean(copyPayload.trim())

  return (
    <Tag
      className={`${className} copyable-error`.trim()}
      role={role}
      title={canCopy ? 'Click to copy' : undefined}
      onClick={() => {
        if (!canCopy) return
        void copyText(copyPayload, { label: 'error' })
      }}
      onKeyDown={(e: { key: string; preventDefault: () => void }) => {
        if (!canCopy) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void copyText(copyPayload, { label: 'error' })
        }
      }}
      tabIndex={canCopy ? 0 : undefined}
    >
      {children}
    </Tag>
  )
}
