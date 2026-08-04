import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Client-only gate before `createPortal` (SSR/hydration). */
export function usePortalledMount() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  return mounted
}

export function renderPortalled(node: ReactNode, portalled: boolean, mounted: boolean) {
  if (!portalled || !mounted) return node
  return createPortal(node, document.body)
}
