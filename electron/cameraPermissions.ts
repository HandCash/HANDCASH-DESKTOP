export type CameraPermissionDetails = {
  isMainFrame: boolean
  requestingUrl: string
  mediaTypes?: string[]
  mediaType?: 'video' | 'audio' | 'unknown'
}

const CAMERA_PERMISSIONS = new Set(['media', 'camera', 'video-capture'])

export function isCameraPermission(permission: string): boolean {
  return CAMERA_PERMISSIONS.has(permission)
}

export function allowsCameraMediaType(
  mediaTypes?: string[],
  mediaType?: 'video' | 'audio' | 'unknown',
): boolean {
  if (mediaTypes?.length) return mediaTypes.includes('video')
  if (mediaType && mediaType !== 'unknown') return mediaType === 'video'
  return true
}

/** Grant camera access only to the main app frame on trusted renderer URLs. */
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
