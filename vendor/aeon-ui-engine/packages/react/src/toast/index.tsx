import { CloseTrigger, Description, Root, Show, Title } from './primitives.js'
import { ToastProvider, ToastViewport, useToast } from './provider.js'

export type { ToastRootProps } from './primitives.js'
export type { ToastPublishOptions, ToastRecord, ToastStore } from './context.js'
export type { ToastPlacement, ToastProviderProps, ToastViewportProps } from './provider.js'
export { useToastStore } from './context.js'
export { ToastItem } from './toast-item.js'

export const Toast = {
  Provider: ToastProvider,
  Viewport: ToastViewport,
  Root,
  Title,
  Description,
  CloseTrigger,
  Show,
}

export { useToast }
