import { FileUpload as Headless } from '@aeon-ui/react'
import { aeonFileUpload } from '@aeon-ui/panda/styled-system/recipes'
import type { ComponentProps } from 'react'
import { cn } from './cn.js'

const recipe = aeonFileUpload()

export const FileUpload = {
  Root: ({ className, ...props }: ComponentProps<typeof Headless.Root>) => (
    <Headless.Root className={cn(recipe.root, className)} {...props} />
  ),
  Label: ({ className, ...props }: ComponentProps<typeof Headless.Label>) => (
    <Headless.Label className={cn(recipe.label, className)} {...props} />
  ),
  Dropzone: ({ className, ...props }: ComponentProps<typeof Headless.Dropzone>) => (
    <Headless.Dropzone className={cn(recipe.dropzone, className)} {...props} />
  ),
  Input: ({ className, ...props }: ComponentProps<typeof Headless.Input>) => (
    <Headless.Input className={cn(recipe.input, className)} {...props} />
  ),
  Hint: ({ className, ...props }: ComponentProps<typeof Headless.Hint>) => (
    <Headless.Hint className={cn(recipe.hint, className)} {...props} />
  ),
  Preview: ({ className, ...props }: ComponentProps<typeof Headless.Preview>) => (
    <Headless.Preview className={cn(recipe.preview, className)} {...props} />
  ),
  ClearTrigger: ({ className, ...props }: ComponentProps<typeof Headless.ClearTrigger>) => (
    <Headless.ClearTrigger className={cn(recipe.clearTrigger, className)} {...props} />
  ),
  RejectionMessage: ({
    className,
    ...props
  }: ComponentProps<typeof Headless.RejectionMessage>) => (
    <Headless.RejectionMessage className={cn(recipe.rejectionMessage, className)} {...props} />
  ),
}
