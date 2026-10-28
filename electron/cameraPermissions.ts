export type CameraPermissionDetails = {
  isMainFrame: boolean
  requestingUrl: string
  mediaTypes?: string[]
  mediaType?: 'video' | 'audio' | 'unknown'
}

const CAMERA_PERMISSIONS = new Set(['media', 'camera', 'video-capture', 'microphone', 'audio-capture'])

export function isCameraPermission(permission: string): boolean {
  return CAMERA_PERMISSIONS.has(permission)
}

/** Camera (QR scanning, video calls) and microphone (calls); nothing else rides `media`. */
export function allowsCameraMediaType(
  mediaTypes?: string[],
  mediaType?: 'video' | 'audio' | 'unknown',
): boolean {
  if (mediaTypes?.length) return mediaTypes.every((t) => t === 'video' || t === 'audio')
  if (mediaType && mediaType !== 'unknown') return mediaType === 'video' || mediaType === 'audio'
  return true
}

/** Grant camera and microphone access only to the main app frame on trusted renderer URLs. */
export function grantsAppCameraPermission(opts: {
  webContentsId: number
  mainWebContentsId: number | undefined
  permission: string
  details: CameraPermissionDetails
  isAppUrl: (url: string) => boolean
}): boolean {
  const { webContentsId, mainWebContentsId, permission, details, isAppUrl } = opts
  if (mainWebContentsId === undefined || webContentsId !== mainWebContentsId) return false
  if (!details.isMainFrame) return false
  if (!isCameraPermission(permission)) return false
  if (!allowsCameraMediaType(details.mediaTypes, details.mediaType)) return false
  return isAppUrl(details.requestingUrl)
}
