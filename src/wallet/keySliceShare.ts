import { sliceSetLabel } from './brc140IssuedSet'

export type KeySliceShareOutcome = 'shared' | 'cancelled' | 'unavailable'

export type KeySliceSharePayload = {
  share: string
  index: number
  total: number
  integrity: string
  issuedAt?: number
}

/** Share one BRC-140 slice through the device's native share surface. */
export async function shareKeySlice(
  payload: KeySliceSharePayload,
): Promise<KeySliceShareOutcome> {
  const title = `HandCash key slice ${payload.index + 1} of ${payload.total}`
  const text = [
    title,
    `Integrity: ${payload.integrity}`,
    ...(payload.issuedAt ? [sliceSetLabel(payload.issuedAt)] : []),
    '',
    payload.share.trim(),
    '',
    `Keep this separate from your other ${payload.total - 1} slices.`,
    'Only slices from the same set combine.',
  ].join('\n')

  if (typeof window !== 'undefined' && window.handcash?.shareText) {
    const result = await window.handcash.shareText({ title, text })
    if (!result.ok) throw new Error(result.error)
    return result.canceled ? 'cancelled' : 'shared'
  }

  if (typeof navigator === 'undefined') return 'unavailable'
  const nav = navigator as Navigator & {
    share?: (data: ShareData) => Promise<void>
  }
  if (typeof nav.share !== 'function') return 'unavailable'
  try {
    await nav.share({ title, text })
    return 'shared'
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
    throw err
  }
}
