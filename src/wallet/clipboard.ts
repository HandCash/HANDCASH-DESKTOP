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
  try {
    if (window.handcash?.clipboardWrite) {
      await window.handcash.clipboardWrite(text)
      return true
    }
  } catch {
    // fall through
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
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}
