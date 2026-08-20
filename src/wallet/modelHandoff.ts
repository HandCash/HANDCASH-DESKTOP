import { collectableModelExtension } from './collectableMedia'
import { filenameForCollectable } from './imageHandoff'
import { playWalletSound } from './soundService'
import { toastError, toastSuccess } from './toast'

const MAX_MODEL_BYTES = 250 * 1024 * 1024

export async function saveCollectableModel(args: {
  url: string
  name: string
  mimeType?: string
}): Promise<boolean> {
  try {
    const response = await fetch(args.url, {
      mode: 'cors',
      credentials: 'omit',
      cache: 'force-cache',
    })
    if (!response.ok) throw new Error(`model fetch failed (${response.status})`)
    const declaredSize = Number(response.headers.get('content-length') || '0')
    if (declaredSize > MAX_MODEL_BYTES) throw new Error('model is too large to save')
    const blob = await response.blob()
    if (blob.size <= 0) throw new Error('empty model')
    if (blob.size > MAX_MODEL_BYTES) throw new Error('model is too large to save')

    const filename = filenameForCollectable(
      args.name,
      collectableModelExtension(args.mimeType || blob.type, args.url),
    )
    const href = URL.createObjectURL(blob)
    try {
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = filename
      anchor.rel = 'noopener'
      anchor.click()
    } finally {
      URL.revokeObjectURL(href)
    }
    playWalletSound('soft')
    toastSuccess('3D model saved')
    return true
  } catch (error) {
    playWalletSound('error')
    toastError('Couldn’t save 3D model', error instanceof Error ? error.message : String(error))
    return false
  }
}
