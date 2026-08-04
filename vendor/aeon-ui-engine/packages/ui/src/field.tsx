import { Field as Headless } from '@aeon-ui/react'
import { aeonField } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const styles = () => aeonField()

export const Field = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => {
    const s = styles()
    return <Headless.Root className={cn(s.root, className)} {...props} />
  },
  Label: ({ className, ...props }: ComponentProps<typeof Headless.Label>) => {
    const s = styles()
    return <Headless.Label className={cn(s.label, className)} {...props} />
  },
  Control: ({ className, ...props }: ComponentProps<typeof Headless.Control>) => {
    const s = styles()
    return <Headless.Control className={cn(s.control, className)} {...props} />
  },
  /** Alias for Control — preferred name in app forms. */
  Input: ({ className, ...props }: ComponentProps<typeof Headless.Control>) => {
    const s = styles()
    return <Headless.Control className={cn(s.control, className)} {...props} />
  },
  Textarea: ({ className, ...props }: ComponentProps<typeof Headless.Textarea>) => {
    const s = styles()
    return <Headless.Textarea className={cn(s.textarea, className)} {...props} />
  },
  Message: ({ className, ...props }: ComponentProps<typeof Headless.Message>) => {
    const s = styles()
    return <Headless.Message className={cn(s.message, className)} {...props} />
  },
  Hint: ({ className, ...props }: ComponentProps<typeof Headless.Hint>) => {
    const s = styles()
    return <Headless.Hint className={cn(s.hint, className)} {...props} />
  },
}
