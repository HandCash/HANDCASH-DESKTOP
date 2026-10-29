import { playWalletSound } from './soundService'
import { toastCopied, toastError } from './toast'

/** Copy text with Electron IPC fallback when Clipboard API is blocked. */
export async function copyText(text: string, opts?: { label?: string; quiet?: boolean }): Promise<boolean> {
  const ok = await writeClipboard(text)
  if (ok) {
    playWalletSound('copy')
    if (!opts?.quiet) toastCopied(opts?.label)
    return true
  }
  playWalletSound('error')
  if (!opts?.quiet) toastError('Couldn’t copy')
  return false
}

async function writeClipboard(text: string): Promise<boolean> {
  // Native shell first: WebKit often blocks navigator.clipboard, and on Wayland
  // the host must own the selection (wl-copy / long-lived arboard).
  if (window.handcash?.clipboardWrite) {
    try {
      await window.handcash.clipboardWrite(text)
      return true
    } catch (err) {
      console.warn('[clipboard] native write failed', err)
      // Still try browser paths — e.g. Chromium Electron where IPC is optional.
    }
  }

  try {
    await navigator.clipboard.writeText(text)
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
    el.focus()
    el.select()
    el.setSelectionRange(0, el.value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}
