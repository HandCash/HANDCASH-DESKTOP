import { Button as Headless } from '@aeon-ui/react'
import { aeonButton, aeonButtonGroup } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type ButtonProps = ComponentProps<typeof Headless.Root> & {
  status?: ComponentProps<typeof Headless.Root>['status']
}
type ButtonGroupProps = ComponentProps<typeof Headless.Group> & {
  orientation?: 'horizontal' | 'vertical'
  gap?: 'sm' | 'md' | 'lg'
}

export const Button = {
  Root: ({ className, variant = 'solid', size = 'md', status = 'idle', ...props }: ButtonProps) => (
    <Headless.Root
      className={cn(aeonButton({ variant, size }), className)}
      data-aeon-size={size}
      variant={variant}
      size={size}
      status={status}
      {...props}
    />
  ),
  Group: ({
    className,
    orientation = 'horizontal',
    gap = 'sm',
    ...props
  }: ButtonGroupProps) => (
    <Headless.Group
      className={cn(aeonButtonGroup({ orientation, gap }), className)}
      {...props}
    />
  ),
  Label: Headless.Label,
  Icon: Headless.Icon,
}
