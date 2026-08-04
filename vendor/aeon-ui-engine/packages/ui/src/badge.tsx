import { aeonBadge } from '@aeon-ui/panda/styled-system/recipes'
import type { HTMLAttributes } from 'react'
import { cn } from './cn.js'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'accent' | 'danger'
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      data-aeon-scope="badge"
      data-aeon-part="root"
      className={cn(aeonBadge({ variant }), className)}
      {...props}
    />
  )
}
