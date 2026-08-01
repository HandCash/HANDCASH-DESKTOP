import { useEffect } from 'react'
import { APP_VERSION } from '../version'
import { playWalletSound } from '../wallet/soundService'
import { toastSuccess } from '../wallet/toast'

/**
 * Bridges View → Copy Screenshot (⌘⇧S / Ctrl+Shift+S) into the shared toast host.
 */
export function ScreenshotToast() {
  useEffect(() => {
    if (!window.handcash?.onScreenshotCopied) return
    return window.handcash.onScreenshotCopied((payload) => {
      playWalletSound('copy')
      toastSuccess('Screenshot copied', `v${payload.version || APP_VERSION} BETA`)
    })
  }, [])

  return null
}
