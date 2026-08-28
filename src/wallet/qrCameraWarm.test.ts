import { beforeEach, describe, expect, it, vi } from 'vitest'

const openQrCamera = vi.fn()

vi.mock('./qrCameraConstraints', () => ({
  openQrCamera: (...args: unknown[]) => openQrCamera(...args),
}))

describe('qrCameraWarm', () => {
  beforeEach(() => {
    openQrCamera.mockReset()
    vi.resetModules()
  })

  it('does not open the camera on warm (Scan not visible)', async () => {
    const { warmQrCamera } = await import('./qrCameraWarm')
    warmQrCamera()
    warmQrCamera()
    expect(openQrCamera).not.toHaveBeenCalled()
  })

  it('opens getUserMedia only when a scanner takes the stream', async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] }
    openQrCamera.mockResolvedValue(stream)
    const { takeQrCameraStream } = await import('./qrCameraWarm')
    await expect(takeQrCameraStream()).resolves.toBe(stream)
    expect(openQrCamera).toHaveBeenCalledTimes(1)
  })

  it('stops tracks on release even if open is still in flight', async () => {
    const stop = vi.fn()
    let resolveOpen: (s: { getTracks: () => Array<{ stop: () => void }> }) => void
    openQrCamera.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve
        }),
    )
    const { takeQrCameraStream, releaseWarmedQrCamera } = await import('./qrCameraWarm')
    const pending = takeQrCameraStream()
    releaseWarmedQrCamera()
    resolveOpen!({ getTracks: () => [{ stop }] })
    await expect(pending).rejects.toThrow(/closed/i)
    expect(stop).toHaveBeenCalled()
  })
})
