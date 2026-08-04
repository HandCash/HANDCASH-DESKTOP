import { Composer as Headless } from '@aeon-ui/react'
import { aeonComposer } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

type RootProps = ComponentProps<typeof Headless.Root>
type InputProps = ComponentProps<typeof Headless.Input>
type ActionsProps = ComponentProps<typeof Headless.Actions>
type SendProps = ComponentProps<typeof Headless.Send>
type ToolbarProps = ComponentProps<typeof Headless.Toolbar>
type SuggestionsProps = ComponentProps<typeof Headless.Suggestions>
type SuggestionProps = ComponentProps<typeof Headless.Suggestion>

type Styles = ReturnType<typeof aeonComposer> & {
  toolbar?: string
  suggestions?: string
  suggestion?: string
}

function styles(): Styles {
  return aeonComposer() as Styles
}

export const Composer = {
  Root: ({ className, ...props }: RootProps) => {
    const s = styles()
    return <Headless.Root className={cn(s.root, className)} {...props} />
  },
  Input: ({ className, ...props }: InputProps) => {
    const s = styles()
    return <Headless.Input className={cn(s.input, className)} {...props} />
  },
  Actions: ({ className, ...props }: ActionsProps) => {
    const s = styles()
    return <Headless.Actions className={cn(s.actions, className)} {...props} />
  },
  Send: ({ className, ...props }: SendProps) => {
    const s = styles()
    return <Headless.Send className={cn(s.send, className)} {...props} />
  },
  Toolbar: ({ className, ...props }: ToolbarProps) => {
    const s = styles()
    return <Headless.Toolbar className={cn(s.toolbar ?? s.actions, className)} {...props} />
  },
  Suggestions: ({ className, ...props }: SuggestionsProps) => {
    const s = styles()
    return <Headless.Suggestions className={cn(s.suggestions, className)} {...props} />
  },
  Suggestion: ({ className, ...props }: SuggestionProps) => {
    const s = styles()
    return <Headless.Suggestion className={cn(s.suggestion, className)} {...props} />
  },
}
