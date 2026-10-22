import { describe, expect, it } from 'vitest'
import {
  allowsCameraMediaType,
  grantsAppCameraPermission,
  isCameraPermission,
} from './cameraPermissions.js'

describe('cameraPermissions', () => {
  const isAppUrl = (url: string) => url.startsWith('http://localhost:5173')

  it('recognizes camera permission names', () => {
    expect(isCameraPermission('media')).toBe(true)
    expect(isCameraPermission('camera')).toBe(true)
    expect(isCameraPermission('video-capture')).toBe(true)
    expect(isCameraPermission('geolocation')).toBe(false)
  })

  it('allows camera and microphone requests for calls', () => {
    expect(allowsCameraMediaType(['video'])).toBe(true)
    expect(allowsCameraMediaType(['audio'])).toBe(true)
    expect(allowsCameraMediaType(['audio', 'video'])).toBe(true)
    expect(allowsCameraMediaType(['audio', 'screen'])).toBe(false)
    expect(allowsCameraMediaType(undefined, 'video')).toBe(true)
    expect(allowsCameraMediaType(undefined, 'audio')).toBe(true)
    expect(allowsCameraMediaType(undefined)).toBe(true)
  })

  it('names the microphone as a media permission', () => {
    expect(isCameraPermission('microphone')).toBe(true)
    expect(isCameraPermission('audio-capture')).toBe(true)
  })

  it('grants main-frame app camera on trusted URLs', () => {
    expect(
      grantsAppCameraPermission({
        webContentsId: 1,
        mainWebContentsId: 1,
        permission: 'media',
        details: {
          isMainFrame: true,
          requestingUrl: 'http://localhost:5173/scan',
          mediaTypes: ['video'],
        },
        isAppUrl,
      }),
    ).toBe(true)
  })

  it('refuses subframes and foreign origins', () => {
    expect(
      grantsAppCameraPermission({
        webContentsId: 2,
        mainWebContentsId: 1,
        permission: 'media',
        details: {
          isMainFrame: true,
          requestingUrl: 'http://localhost:5173/scan',
        },
        isAppUrl,
      }),
    ).toBe(false)
    expect(
      grantsAppCameraPermission({
        webContentsId: 1,
        mainWebContentsId: 1,
        permission: 'media',
        details: {
          isMainFrame: false,
          requestingUrl: 'http://localhost:5173/scan',
        },
        isAppUrl,
      }),
    ).toBe(false)
    expect(
      grantsAppCameraPermission({
        webContentsId: 1,
        mainWebContentsId: 1,
        permission: 'media',
        details: {
          isMainFrame: true,
          requestingUrl: 'https://evil.example/',
        },
        isAppUrl,
      }),
    ).toBe(false)
  })
})
