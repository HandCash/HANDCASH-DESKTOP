import { playWalletSound } from './soundService'

/** Copy text with Electron IPC fallback when Clipboard API is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.handcash?.clipboardWrite) {
      await window.handcash.clipboardWrite(text)
      playWalletSound('copy')
      return true
    }
  } catch {
    // fall through
  }

  try {
    await navigator.clipboard.writeText(text)
    playWalletSound('copy')
    return true
  } catch {
    // fall through
  }

  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    if (ok) playWalletSound('copy')
    return ok
  } catch {
    return false
  }
}
