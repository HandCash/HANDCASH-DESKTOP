import { Prompt as Headless } from '@aeon-ui/react'
import type { ComponentProps } from 'react'
import { Dialog } from './dialog.js'
import { cn } from './cn.js'

/** Styled Prompt — Dialog recipes + prompt action parts. */
export const Prompt = {
  Root: Headless.Root,
  Trigger: Dialog.Trigger,
  Portal: Dialog.Portal,
  Backdrop: Dialog.Backdrop,
  Positioner: Dialog.Positioner,
  Content: Dialog.Content,
  Title: Dialog.Title,
  Description: Dialog.Description,
  CloseTrigger: Dialog.CloseTrigger,
  Eyebrow: ({ className, ...props }: ComponentProps<typeof Headless.Eyebrow>) => (
    <Headless.Eyebrow className={cn(className)} {...props} />
  ),
  Meta: Headless.Meta,
  Amount: Headless.Amount,
  Verb: Headless.Verb,
  Recipient: Headless.Recipient,
  Effect: Headless.Effect,
  Actions: Headless.Actions,
  Primary: ({ className, ...props }: ComponentProps<typeof Headless.Primary>) => (
    <Headless.Primary className={cn(className)} {...props} />
  ),
  Secondary: ({ className, ...props }: ComponentProps<typeof Headless.Secondary>) => (
    <Headless.Secondary className={cn(className)} {...props} />
  ),
}
