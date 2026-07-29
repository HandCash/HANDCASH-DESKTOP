import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

/** Render overlays on document.body so parent transform/overflow can't trap them. */
export function ModalPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}
