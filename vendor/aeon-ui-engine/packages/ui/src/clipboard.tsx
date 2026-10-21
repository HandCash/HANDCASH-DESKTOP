import { Clipboard as Headless } from '@aeon-ui/react'
import { aeonClipboard } from '@aeon-ui/panda/styled-system/recipes'
import { forwardRef, type ComponentPropsWithoutRef } from 'react'
import { cn } from './cn.js'

const clipboard = aeonClipboard()

const icon = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

const CopyIcon = () => (
  <svg {...icon}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
)

const CheckIcon = () => (
  <svg {...icon}>
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
)

const Root = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof Headless.Root>>(function Clipboard(
  { className, ...props },
  ref,
) {
  return <Headless.Root ref={ref} className={cn(clipboard.root, className)} {...props} />
})

const Indicator = forwardRef<HTMLSpanElement, ComponentPropsWithoutRef<typeof Headless.Indicator>>(
  function ClipboardIndicator({ className, copied = <CheckIcon />, children = <CopyIcon />, ...props }, ref) {
    return (
      <Headless.Indicator ref={ref} className={cn(clipboard.indicator, className)} copied={copied} {...props}>
        {children}
      </Headless.Indicator>
    )
  },
)

/** With no children, shows a copy icon that turns into a check once copied. */
const Trigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Headless.Trigger>>(
  function ClipboardTrigger({ className, children = <Indicator />, ...props }, ref) {
    return (
      <Headless.Trigger ref={ref} className={cn(clipboard.trigger, className)} {...props}>
        {children}
      </Headless.Trigger>
    )
  },
)

export const Clipboard = { Root, Trigger, Indicator }
