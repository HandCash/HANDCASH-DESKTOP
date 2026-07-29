import type { ReactNode } from 'react'

type Props = {
  title: string
  value: string
  children?: ReactNode
  showQr?: boolean
  onShowQr?: (label: string, value: string) => void
  onCopy?: (value: string) => void
}

export function ValueMetric({ title, value, children, showQr = false, onShowQr, onCopy }: Props) {
  return (
    <div className="metric" data-aeon-scope="field" data-aeon-part="root">
      <div className="metric-head">
        <h3>{title}</h3>
        <div className="metric-actions">
          {showQr && onShowQr && (
            <button
              type="button"
              className="btn btn-ghost btn-compact"
              onClick={() => onShowQr(title, value)}
              aria-label={`Show QR for ${title}`}
            >
              QR
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => void (onCopy ? onCopy(value) : navigator.clipboard.writeText(value))}
            aria-label={`Copy ${title}`}
          >
            Copy
          </button>
        </div>
      </div>
      {children ?? <p className="mono">{value}</p>}
    </div>
  )
}
