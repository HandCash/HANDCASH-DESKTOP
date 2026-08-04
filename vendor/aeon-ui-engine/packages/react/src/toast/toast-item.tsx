import { forwardRef, type HTMLAttributes } from 'react'
import type { ToastRecord } from './context.js'
import { CloseTrigger, Description, Root, Title } from './primitives.js'

export type ToastItemProps = HTMLAttributes<HTMLDivElement> & {
  item: ToastRecord
  onExited: (id: string) => void
}

export const ToastItem = forwardRef<HTMLDivElement, ToastItemProps>(function ToastItem(
  { item, onExited, className, ...rest },
  ref,
) {
  const { id, title, description, durationMs } = item

  return (
    <Root
      ref={ref}
      className={className}
      defaultVisible
      durationMs={durationMs ?? 5000}
      onVisibleChange={(visible) => {
        if (!visible) onExited(id)
      }}
      {...rest}
    >
      {title ? <Title>{title}</Title> : null}
      {description ? <Description>{description}</Description> : null}
      <CloseTrigger />
    </Root>
  )
})
