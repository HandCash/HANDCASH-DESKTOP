import type { CSSProperties, HTMLAttributes } from 'react'

type SkeletonProps = HTMLAttributes<HTMLSpanElement> & {
  width?: number | string
  height?: number | string
  radius?: number | string
}

export function Skeleton({
  width,
  height,
  radius,
  className = '',
  style,
  ...rest
}: SkeletonProps) {
  const merged: CSSProperties = {
    width,
    height,
    borderRadius: radius,
    ...style,
  }
  return (
    <span
      className={`skeleton ${className}`.trim()}
      style={merged}
      aria-hidden
      {...rest}
    />
  )
}

export function SkeletonAvatar({ size = 'sm' }: { size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`skeleton skeleton-avatar skeleton-avatar-${size}`} aria-hidden />
}

export function SkeletonLine({
  width = '70%',
  height = 12,
}: {
  width?: number | string
  height?: number | string
}) {
  return <Skeleton className="skeleton-line" width={width} height={height} />
}

export function SkeletonAppRow() {
  return (
    <div className="skeleton-app-row" aria-hidden>
      <SkeletonAvatar size="sm" />
      <div className="skeleton-app-row-body">
        <SkeletonLine width="42%" height={14} />
        <SkeletonLine width="58%" height={10} />
      </div>
      <div className="skeleton-app-row-meta">
        <SkeletonLine width={72} height={14} />
        <SkeletonLine width={54} height={8} />
      </div>
    </div>
  )
}

export function SkeletonAppCard() {
  return (
    <div className="skeleton-app-card" aria-hidden>
      <SkeletonAvatar size="md" />
      <SkeletonLine width="70%" height={14} />
      <SkeletonLine width="55%" height={10} />
      <SkeletonLine width="60%" height={12} />
    </div>
  )
}

export function SkeletonHistoryRow() {
  return (
    <div className="skeleton-history-row" aria-hidden>
      <SkeletonAvatar size="sm" />
      <div className="skeleton-app-row-body">
        <SkeletonLine width="48%" height={13} />
        <SkeletonLine width="28%" height={10} />
      </div>
      <SkeletonLine width={64} height={14} />
    </div>
  )
}

export function SkeletonQr({ size = 180 }: { size?: number }) {
  return (
    <span
      className="skeleton skeleton-qr"
      style={{ width: size, height: size }}
      aria-hidden
    />
  )
}
