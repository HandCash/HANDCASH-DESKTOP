import { useEffect, useState } from 'react'
import { APP_VERSION } from '../version'
import { playWalletSound } from '../wallet/soundService'

/**
 * Brief confirmation when View → Copy Screenshot (⌘⇧S / Ctrl+Shift+S) lands on the clipboard.
 */
export function ScreenshotToast() {
  const [visible, setVisible] = useState(false)
  const [version, setVersion] = useState<string>(APP_VERSION)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    if (!window.handcash?.onScreenshotCopied) return
    return window.handcash.onScreenshotCopied((payload) => {
      setFailed(null)
      setVersion(payload.version || APP_VERSION)
      setVisible(true)
      playWalletSound('copy')
    })
  }, [])

  useEffect(() => {
    if (!visible && !failed) return
    const id = window.setTimeout(() => {
      setVisible(false)
      setFailed(null)
    }, 2400)
    return () => window.clearTimeout(id)
  }, [visible, failed])

  if (!visible && !failed) return null

  return (
    <div
      className={`screenshot-toast${failed ? ' is-error' : ''}`}
      role="status"
      aria-live="polite"
      data-aeon-scope="screenshot-toast"
      data-aeon-state={failed ? 'error' : 'copied'}
    >
      {failed ? failed : `Screenshot copied · v${version} BETA`}
    </div>
  )
}
