export function isMobileCameraPlatform(platform?: string): boolean {
  return platform === 'android' || platform === 'ios'
}

export function buildQrCameraConstraints(platform?: string): MediaStreamConstraints {
  const mobile = isMobileCameraPlatform(platform)
  return {
    audio: false,
    video: mobile
      ? {
          facingMode: { ideal: 'environment' },
          // 720p plus full-rate software decode overheats Android WebViews. QR
          // modules remain crisp at 960×540 while cutting pixel work nearly in half.
          width: { ideal: 960 },
          height: { ideal: 540 },
        }
      : {
          // Laptops/desktops only expose a front camera; `environment` often fails on Linux/Windows.
          // Prefer a modest ideal so getUserMedia returns sooner than 720p renegotiation.
          facingMode: { ideal: 'user' },
          width: { ideal: 960 },
          height: { ideal: 540 },
          frameRate: { ideal: 24, max: 30 },
        },
  }
}

/** Last-resort constraints when ideal facingMode / resolution are rejected. */
export function buildQrCameraFallbackConstraints(): MediaStreamConstraints {
  return { audio: false, video: true }
}

export function shouldRetryQrCamera(err: unknown, platform?: string): boolean {
  if (isMobileCameraPlatform(platform)) return false
  if (!(err instanceof DOMException)) return true
  if (err.name === 'NotAllowedError' || err.name === 'SecurityError') return false
  return (
    err.name === 'OverconstrainedError' ||
    err.name === 'NotFoundError' ||
    err.name === 'NotReadableError' ||
    err.name === 'AbortError'
  )
}

export async function openQrCamera(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  platform?: string,
): Promise<MediaStream> {
  try {
    return await getUserMedia(buildQrCameraConstraints(platform))
  } catch (err) {
    if (!shouldRetryQrCamera(err, platform)) throw err
    return getUserMedia(buildQrCameraFallbackConstraints())
  }
}
