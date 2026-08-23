import { describe, expect, it } from 'vitest'
import {
  buildQrCameraConstraints,
  buildQrCameraFallbackConstraints,
  isMobileCameraPlatform,
  shouldRetryQrCamera,
} from './qrCameraConstraints'

describe('qrCameraConstraints', () => {
  it('uses rear camera on mobile', () => {
    const c = buildQrCameraConstraints('android').video as MediaTrackConstraints
    expect(c.facingMode).toEqual({ ideal: 'environment' })
    expect(c.width).toEqual({ ideal: 960 })
  })

  it('uses front camera on desktop platforms', () => {
    for (const platform of ['linux', 'win32', 'darwin', 'web', undefined]) {
      const c = buildQrCameraConstraints(platform).video as MediaTrackConstraints
      expect(c.facingMode).toEqual({ ideal: 'user' })
    }
  })

  it('fallback constraints accept any camera', () => {
    expect(buildQrCameraFallbackConstraints()).toEqual({ audio: false, video: true })
  })

  it('retries desktop camera errors but not permission denials', () => {
    expect(shouldRetryQrCamera(new DOMException('x', 'OverconstrainedError'), 'linux')).toBe(true)
    expect(shouldRetryQrCamera(new DOMException('x', 'NotAllowedError'), 'linux')).toBe(false)
    expect(shouldRetryQrCamera(new DOMException('x', 'OverconstrainedError'), 'android')).toBe(
      false,
    )
  })

  it('classifies mobile platforms', () => {
    expect(isMobileCameraPlatform('android')).toBe(true)
    expect(isMobileCameraPlatform('ios')).toBe(true)
    expect(isMobileCameraPlatform('linux')).toBe(false)
  })
})
