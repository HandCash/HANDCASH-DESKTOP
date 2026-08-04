import { Thread as Headless } from '@aeon-ui/react'
import { aeonThread } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type RootProps = ComponentProps<typeof Headless.Root>
type ItemProps = ComponentProps<typeof Headless.Item>
type PartProps = ComponentProps<typeof Headless.Bubble>
type BindProps = ComponentProps<typeof Headless.Bind>

export const Thread = {
  Root: ({ className, ...props }: RootProps) => {
    const styles = aeonThread()
    return <Headless.Root className={cn(styles.root, className)} {...props} />
  },
  List: ({ className, ...props }: PartProps) => {
    const styles = aeonThread()
    return <Headless.List className={cn(styles.list, className)} {...props} />
  },
  Item: ({ className, ...props }: ItemProps) => {
    const styles = aeonThread()
    return <Headless.Item className={cn(styles.item, className)} {...props} />
  },
  Bubble: ({ className, ...props }: PartProps) => {
    const styles = aeonThread()
    return <Headless.Bubble className={cn(styles.bubble, className)} {...props} />
  },
  Meta: ({ className, ...props }: PartProps) => {
    const styles = aeonThread()
    return <Headless.Meta className={cn(styles.meta, className)} {...props} />
  },
  Day: ({ className, ...props }: PartProps) => {
    const styles = aeonThread()
    return <Headless.Day className={cn(styles.day, className)} {...props} />
  },
  Bind: ({ className, ...props }: BindProps) => {
    const styles = aeonThread()
    return (
      <Headless.Bind className={cn((styles as { bind?: string }).bind, className)} {...props} />
    )
  },
  Card: ({ className, ...props }: PartProps) => {
    const styles = aeonThread()
    return (
      <Headless.Card className={cn((styles as { card?: string }).card ?? styles.bubble, className)} {...props} />
    )
  },
  CardTitle: ({ className, ...props }: PartProps) => {
    const styles = aeonThread()
    return (
      <Headless.CardTitle
        className={cn((styles as { cardTitle?: string }).cardTitle, className)}
        {...props}
      />
    )
  },
  CardBody: ({ className, ...props }: PartProps) => {
    const styles = aeonThread()
    return (
      <Headless.CardBody
        className={cn((styles as { cardBody?: string }).cardBody, className)}
        {...props}
      />
    )
  },
  CardActions: ({ className, ...props }: PartProps) => {
    const styles = aeonThread()
    return (
      <Headless.CardActions
        className={cn((styles as { cardActions?: string }).cardActions, className)}
        {...props}
      />
    )
  },
}
