import { Panel as Headless } from '@aeon-ui/react'
import { aeonPanel } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type PanelSize = 'md' | 'lg'

type GroupProps = ComponentProps<typeof Headless.Group>
type RootProps = ComponentProps<typeof Headless.Root> & { size?: PanelSize }
type TriggerProps = ComponentProps<typeof Headless.Trigger>
type LabelProps = ComponentProps<typeof Headless.Label>
type ContentProps = ComponentProps<typeof Headless.Content>

/**
 * Panel — collapsible split-view region for Aeon layouts.
 * Collapsed exposes a vertical upright label rail; expanded shows content.
 */
export const Panel = {
  Group: ({ className, ...props }: GroupProps) => {
    const styles = aeonPanel({})
    return <Headless.Group className={cn(styles.group, className)} {...props} />
  },
  Root: ({ className, size, ...props }: RootProps) => {
    const styles = aeonPanel({ size })
    return <Headless.Root className={cn(styles.root, className)} {...props} />
  },
  Trigger: ({ className, ...props }: TriggerProps) => {
    const styles = aeonPanel({})
    return <Headless.Trigger className={cn(styles.trigger, className)} {...props} />
  },
  Label: ({ className, ...props }: LabelProps) => {
    const styles = aeonPanel({})
    return <Headless.Label className={cn(styles.label, className)} {...props} />
  },
  Content: ({ className, ...props }: ContentProps) => {
    const styles = aeonPanel({})
    return <Headless.Content className={cn(styles.content, className)} {...props} />
  },
}
