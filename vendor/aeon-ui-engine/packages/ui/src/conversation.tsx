import { Conversation as Headless } from '@aeon-ui/react'
import { aeonConversation } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type RootProps = ComponentProps<typeof Headless.Root>
type ItemProps = ComponentProps<typeof Headless.Item>
type PartProps = ComponentProps<typeof Headless.Title>

export const Conversation = {
  Root: ({ className, ...props }: RootProps) => {
    const styles = aeonConversation()
    return <Headless.Root className={cn(styles.root, className)} {...props} />
  },
  Item: ({ className, ...props }: ItemProps) => {
    const styles = aeonConversation()
    return <Headless.Item className={cn(styles.item, className)} {...props} />
  },
  Leading: ({ className, ...props }: PartProps) => {
    const styles = aeonConversation()
    return <Headless.Leading className={cn(styles.leading, className)} {...props} />
  },
  Body: ({ className, ...props }: PartProps) => {
    const styles = aeonConversation()
    return <Headless.Body className={cn(styles.body, className)} {...props} />
  },
  Title: ({ className, ...props }: PartProps) => {
    const styles = aeonConversation()
    return <Headless.Title className={cn(styles.title, className)} {...props} />
  },
  Preview: ({ className, ...props }: PartProps) => {
    const styles = aeonConversation()
    return <Headless.Preview className={cn(styles.preview, className)} {...props} />
  },
  Meta: ({ className, ...props }: PartProps) => {
    const styles = aeonConversation()
    return <Headless.Meta className={cn(styles.meta, className)} {...props} />
  },
  Badge: ({ className, ...props }: PartProps) => {
    const styles = aeonConversation()
    return <Headless.Badge className={cn(styles.badge, className)} {...props} />
  },
}
