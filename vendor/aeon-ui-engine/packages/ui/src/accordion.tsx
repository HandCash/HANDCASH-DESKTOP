import { Accordion as Headless } from '@aeon-ui/react'
import { css } from '@aeon-ui/panda/styled-system/css'
import { aeonAccordion } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const accordion = aeonAccordion()
const triggerLabel = css({ flex: '1', minW: '0', pr: 'gapSm' })

export const Accordion = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => (
    <Headless.Root className={cn(accordion.root, className)} {...props} />
  ),
  Item: ({ className, ...props }: ComponentProps<typeof Headless.Item>) => (
    <Headless.Item className={cn(accordion.item, className)} {...props} />
  ),
  ItemTrigger: ({ className, children, ...props }: ComponentProps<typeof Headless.ItemTrigger>) => (
    <Headless.ItemTrigger className={cn(accordion.itemTrigger, className)} {...props}>
      <span className={triggerLabel}>{children}</span>
      <Headless.ItemIndicator className={accordion.itemIndicator}>▾</Headless.ItemIndicator>
    </Headless.ItemTrigger>
  ),
  ItemContent: ({ className, ...props }: ComponentProps<typeof Headless.ItemContent>) => (
    <Headless.ItemContent className={cn(accordion.itemContent, className)} {...props} />
  ),
  ItemIndicator: Headless.ItemIndicator,
}
